// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Auto-response engine for inbound emails.
 *
 * Implements the two mailbox settings that upstream ships as placeholder
 * fields without any consumer:
 *   - autoReply:   { enabled, subject, message }  → sends a fixed reply
 *   - forwarding:  { enabled, email }             → forwards a copy
 *
 * Called from receiveEmail() via ctx.waitUntil() so slow sends never
 * block email acceptance. Includes loop prevention: we never auto-respond
 * to bounces, auto-submitted mail, our own markers, or ourselves.
 */

import { sendEmail } from "../email-sender";
import { generateMessageId } from "./email-helpers";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

export interface AutoReplySettings {
	enabled: boolean;
	subject: string;
	message: string;
}

export interface ForwardingSettings {
	enabled: boolean;
	email: string;
}

export interface MailboxSettings {
	fromName?: string;
	autoReply?: AutoReplySettings;
	forwarding?: ForwardingSettings;
}

export interface ParsedEmailLite {
	subject?: string;
	text?: string;
	html?: string;
	messageId?: string;
	from?: { address?: string };
	to?: { address?: string }[];
	headers: { key: string; value: string }[];
}

/** Header we stamp on our own auto-sent mail to recognise loops. */
const LOOP_MARKER = "X-Agentic-Inbox-Auto-Response";

/** Senders we never auto-respond to (bounces, daemons, no-reply). */
const NO_AUTO_REPLY_SENDER =
	/^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce|bounces|notifications?)@/i;

function headerValue(parsed: ParsedEmailLite, key: string): string | undefined {
	const lower = key.toLowerCase();
	return parsed.headers?.find(
		(h) => h.key?.toLowerCase() === lower,
	)?.value;
}

/**
 * Decide whether an inbound email is itself an automatic message we must
 * not reply to (RFC 3834-ish heuristics, deliberately conservative).
 */
function isAutomatedEmail(parsed: ParsedEmailLite): boolean {
	if (headerValue(parsed, LOOP_MARKER)) return true;

	const autoSubmitted = headerValue(parsed, "Auto-Submitted");
	if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") return true;

	if (
		headerValue(parsed, "X-Autorespond") ||
		headerValue(parsed, "X-Auto-Response-From") ||
		headerValue(parsed, "X-Autoreply")
	) {
		return true;
	}

	const listId = headerValue(parsed, "List-Id");
	if (listId) return true; // mailing lists: never auto-reply

	return false;
}

function wrapForwardHtml(parsed: ParsedEmailLite, mailboxId: string): string {
	const from = parsed.from?.address || "unknown";
	const subject = parsed.subject || "(no subject)";
	const body = parsed.html || `<pre>${parsed.text || ""}</pre>` || "";
	return `<div style="font-family:sans-serif;font-size:13px;color:#666;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">
Forwarded from <strong>${mailboxId}</strong>: ${subject} &mdash; from ${from}
</div>${body}`;
}

/**
 * Fire auto-reply / forwarding for one inbound email.
 * Never throws — all failures are logged and swallowed.
 */
export async function handleAutoResponse(
	env: Env,
	mailboxId: string,
	settings: MailboxSettings | undefined,
	parsed: ParsedEmailLite,
	rawEmail: ArrayBuffer,
): Promise<void> {
	try {
		const sender = (parsed.from?.address || "").toLowerCase();
		if (!sender) return;
		// Never react to our own mailbox or daemon-ish senders
		if (sender === mailboxId.toLowerCase()) return;
		if (NO_AUTO_REPLY_SENDER.test(sender)) return;
		if (isAutomatedEmail(parsed)) return;

		const fromName = settings?.fromName || mailboxId;
		const from = { email: mailboxId, name: fromName };
		const subject = parsed.subject || "";

		// ── Auto-reply ──────────────────────────────────────────
		const ar = settings?.autoReply;
		if (ar?.enabled && ar.subject?.trim() && ar.message?.trim()) {
			const { messageId, outgoingMessageId } = generateMessageId(
				mailboxId.split("@")[1] || "localhost",
			);
			const arHtml = `<div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px">${ar.message
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")}</div>`;

			await sendEmail(env.EMAIL, {
				to: sender,
				from,
				subject: ar.subject,
				html: arHtml,
				text: ar.message,
				headers: {
					[LOOP_MARKER]: "1",
					"Auto-Submitted": "auto-replied",
					"In-Reply-To": `<${parsed.messageId || ""}>`,
				} as Record<string, string>,
			});
			console.log(`Auto-reply sent from ${mailboxId} to ${sender}`);

			// Store in Sent so the UI shows the conversation state
			try {
				const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
				await stub.createEmail(Folders.SENT, {
					id: messageId,
					subject: ar.subject,
					sender: mailboxId,
					recipient: sender,
					cc: null,
					bcc: null,
					date: new Date().toISOString(),
					body: arHtml,
					in_reply_to: null,
					email_references: null,
					thread_id: messageId,
					message_id: outgoingMessageId,
					raw_headers: JSON.stringify([
						{ key: "from", value: `${fromName} <${mailboxId}>` },
						{ key: "to", value: sender },
						{ key: "subject", value: ar.subject },
						{ key: "date", value: new Date().toISOString() },
						{ key: "message-id", value: `<${outgoingMessageId}>` },
					]),
				}, []);
			} catch (e) {
				console.error("Auto-reply Sent-folder store failed:", (e as Error).message);
			}
		}

		// ── Forwarding ──────────────────────────────────────────
		const fw = settings?.forwarding;
		if (fw?.enabled && fw.email?.includes("@")) {
			const { messageId } = generateMessageId(
				mailboxId.split("@")[1] || "localhost",
			);
			const fwdHtml = wrapForwardHtml(parsed, mailboxId);
			await sendEmail(env.EMAIL, {
				to: fw.email,
				from,
				subject: `Fwd: ${subject}`,
				html: fwdHtml,
				text: parsed.text || undefined,
				// Loop-safe: forwarded copies carry the marker so a forwarded
				// account that also auto-replies can never ping-pong with us.
				headers: { [LOOP_MARKER]: "1" } as Record<string, string>,
			});
			console.log(`Forwarded ${mailboxId} mail to ${fw.email}`);
		}
	} catch (e) {
		console.error("Auto-response failed:", (e as Error).message);
	}
}
