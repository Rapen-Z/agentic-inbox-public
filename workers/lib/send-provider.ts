// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Provider-switchable email sending for agentic-inbox.
 *
 * Priority: Resend (free tier, uses RESEND_API_KEY secret) → CF send_email binding.
 * Header-based metadata (threading, loop markers) is passed to Resend as
 * RFC 5322 headers so replies thread correctly in users' mail clients.
 *
 * Sender identity rules (deliberate):
 *   - from = the mailbox address, optionally with a display name
 *   - replyTo is NEVER set: user replies go straight back to support@domain
 */

import { sendEmail as cfSendEmail } from "../email-sender";

export interface UnifiedSendParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	headers?: Record<string, string>;
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
}

function formatFrom(
	from: string | { email: string; name: string },
): string {
	if (typeof from === "string") return from;
	const email = from.email;
	const name = from.name?.trim();
	if (!name) return email;
	// RFC 5322 display name; strip chars that could break the header
	const safeName = name.replace(/["<>\r\n]/g, "").trim();
	return `"${safeName}" <${email}>`;
}

function formatAddr(a: string | { email: string; name: string }): string {
	if (typeof a === "string") return a;
	return a.email;
}

async function sendViaResend(
	apiKey: string,
	params: UnifiedSendParams,
): Promise<{ messageId: string; provider: "resend" }> {
	const body: Record<string, unknown> = {
		from: formatFrom(params.from),
		to: Array.isArray(params.to) ? params.to : [params.to],
		subject: params.subject,
	};
	if (params.html) body.html = params.html;
	if (params.text) body.text = params.text;
	if (params.cc) body.cc = Array.isArray(params.cc) ? params.cc : [params.cc];
	if (params.bcc) body.bcc = Array.isArray(params.bcc) ? params.bcc : [params.bcc];
	if (params.headers && Object.keys(params.headers).length > 0) {
		body.headers = params.headers;
	}
	if (params.attachments && params.attachments.length > 0) {
		body.attachments = params.attachments.map((a) => ({
			filename: a.filename,
			content: a.content,
			content_type: a.type,
			content_id: a.contentId,
		}));
	}

	const resp = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text().catch(() => "");
		throw new Error(`Resend send failed (${resp.status}): ${errText.slice(0, 300)}`);
	}
	const data = (await resp.json()) as { id?: string };
	return { messageId: data.id || "resend-no-id", provider: "resend" };
}

async function sendViaCF(
	binding: SendEmail,
	params: UnifiedSendParams,
): Promise<{ messageId: string; provider: "cf" }> {
	const result = await cfSendEmail(binding, {
		to: params.to,
		from: params.from,
		subject: params.subject,
		html: params.html,
		text: params.text,
		cc: params.cc,
		bcc: params.bcc,
		// NOTE: replyTo intentionally never set — replies go to support@
		attachments: params.attachments,
		headers: params.headers,
	});
	return { messageId: result.messageId, provider: "cf" };
}

/**
 * Send via Resend when RESEND_API_KEY is configured (and the from-domain is
 * verified there — assume yes, per mailbox config), else fall back to the
 * Cloudflare send_email binding (requires Workers Paid).
 */
export async function sendUnified(
	env: { EMAIL?: SendEmail; RESEND_API_KEY?: string },
	params: UnifiedSendParams,
): Promise<{ messageId: string; provider: "resend" | "cf" }> {
	const fromEmail = typeof params.from === "string" ? params.from : params.from.email;

	if (env.RESEND_API_KEY) {
		try {
			return await sendViaResend(env.RESEND_API_KEY, params);
		} catch (e) {
			// If Resend rejects (unverified domain etc.) and we have a CF binding, fall back
			if (env.EMAIL) {
				console.warn("Resend send failed, falling back to CF binding:", (e as Error).message);
				return sendViaCF(env.EMAIL, params);
			}
			throw e;
		}
	}
	if (env.EMAIL) {
		return sendViaCF(env.EMAIL, params);
	}
	throw new Error("No email provider configured (RESEND_API_KEY or EMAIL binding)");
}
