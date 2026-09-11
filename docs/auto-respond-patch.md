# Auto-Reply & Forwarding Patch — Implementation Notes

Details of the patch added on top of upstream cloudflare/agentic-inbox (upstream had the settings as dead placeholder fields). Local source: `/root/projects/agentic-inbox-src/agentic-inbox`, commit `ade9b46` on a local git init (upstream HEAD + patch).

## Files changed

1. **NEW `workers/lib/auto-respond.ts`**
   - Exports `handleAutoResponse(env, mailboxId, settings, parsedEmail, rawEmail): Promise<void>` — never throws; all failures logged and swallowed (fire-and-forget context).
   - Settings come from R2 `mailboxes/<address>.json`:
     - `autoReply: { enabled, subject, message, dailyLimit? }` → sends a fixed reply through `sendUnified` (Resend primary, CF binding fallback — NOT `env.EMAIL.send()` directly); stores a copy in the Sent folder through the MailboxDO `createEmail(Folders.SENT, ...)`.
     - `dailyLimit` (number, optional) = per-mailbox auto-replies per **UTC day**; `0`/undefined = unlimited. Checked in MailboxDO storage (key `autoReplyCount:<YYYY-MM-DD>`, stale keys pruned on read) BEFORE `sendUnified`; incremented AFTER a successful send so failed sends don't burn quota.
     - `forwarding: { enabled, email }` → forwards a copy with a "Forwarded from <mailbox>" banner prepended to the original HTML body.
   - Loop protection (checked before any send):
     - Sender == own mailbox → skip.
     - Sender matches `/^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce|bounces|notifications?)@/i` → skip.
     - Headers checked: `X-Agentic-Inbox-Auto-Response` (our own marker), `Auto-Submitted` (anything ≠ "no"), `X-Autorespond`, `X-Auto-Response-From`, `X-Autoreply`, `List-Id`.
   - Outbound auto-replies carry `Auto-Submitted: auto-replied` + the loop marker header; forwarded copies carry the marker too (so a forwarded account that also auto-replies can't ping-pong).

2. **`workers/index.ts`**
   - `import { handleAutoResponse } from "./lib/auto-respond";`
   - In `receiveEmail()`, after the agent auto-draft `ctx.waitUntil(...)` block:
     ```ts
     ctx.waitUntil(handleAutoResponse(env, mailboxId,
       await (async () => {
         try {
           const cfg = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
           return cfg ? await cfg.json() : undefined;
         } catch { return undefined; }
       })(),
       parsedEmail as never, rawEmail.buffer as ArrayBuffer));
     ```
   - Note `rawEmail.buffer as ArrayBuffer` — PostalMime-adjacent stream helper returns a Uint8Array; tsc requires the cast.

3. **`app/routes/settings.tsx`**
   - State: autoReply enabled/subject/message/dailyLimit, forwarding enabled/email.
   - `handleSave` merges them into the settings PUT payload (API accepts `z.record(z.any())`, no server validation needed).
   - UI panels sit between **Signature** and **Agent System Prompt**: Auto Reply (checkbox + Subject Input + Message textarea + dailyLimit number input labeled "0 = unlimited") and Forwarding (checkbox + email Input). Styling follows existing kumo classes (`kumo-line`, `kumo-base`, `kumo-recessed`, etc.).
   - When merging upstream UI changes wholesale, diff the new `settings.tsx` against this patch BEFORE deploying — an upstream take-over can silently drop the panels, leaving `autoReply.enabled=false` in R2 with no way to enable it from the UI.

## Typecheck notes

- `npx wrangler types` regenerates `worker-configuration.d.ts` from `wrangler.jsonc` (needed after any binding change, and once after fresh `npm install`).
- `npx tsc -p tsconfig.cloudflare.json --noEmit` shows one pre-existing upstream error (`Cannot find module 'virtual:react-router/server-build'`) that is NOT ours — it resolves during `npm run build`. Grep it out when checking for new errors.
- Final validation: `npm run build` (full React Router + worker build) and `npx wrangler deploy --dry-run` both passed.

## Upstream behavior to remember

- AI agent auto-drafts replies on new mail (`EmailAgent` DO, `onNewEmail` hook) but **never auto-sends** — manual confirm required; separate from this fixed auto-reply.
- `EMAIL_ADDRESSES` env var: non-empty = strict allowlist, silently ignores other recipients.
- Settings PUT endpoint accepts arbitrary JSON and writes straight to R2; default settings seeded on mailbox create include the now-live `autoReply`/`forwarding` blocks.
