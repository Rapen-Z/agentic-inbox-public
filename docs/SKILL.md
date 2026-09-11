---
name: cloudflare-email-self-hosting
description: Use when self-hosting CF Workers email or agentic-inbox — from-zero setup (deploy, Access OTP auth, Resend domains, Email Routing, mailboxes), sending/receiving ops, and troubleshooting.
---

# Cloudflare Email Self-Hosting (Workers-based inbox)

Class-level playbook for running a self-hosted inbox entirely on CF: receiving via **Email Routing**, sending via **Resend API (primary) / `send_email` binding (fallback)**, per-mailbox isolation in Durable Objects, attachments in R2. Reference implementation: Cloudflare's open-source **agentic-inbox** (web client + AI agent that auto-drafts replies, MCP endpoint at `/mcp`).

## Reference implementation & our fork

Patch history detail: `references/auto-respond-patch.md`. Sending/auth detail: `references/resend-sending-auth.md`. security00 fork upgrade merge (2026-09-10): `references/security00-upgrade-merge.md`.

- Your fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). Recommended customizations (all in this playbook): `sendUnified` Resend sending, auto-reply/forwarding engine with daily limit, Access/service-binding auth middleware. Merge took upstream UI wholesale, kept our `sendUnified` Resend sending + auto-respond engine + Access/service-binding middleware. Current send stack: **Resend primary (verified domains only) + CF `send_email` binding fallback** — see comparison table in `references/security00-upgrade-merge.md`.
- **Preview-alias pitfall**: `wrangler versions upload --preview-alias X` only serves when API returns `has_preview: true` (URL = `<alias>-<workerName>.<subdomain>.workers.dev`, dash-joined). **DO workers reliably get `has_preview=false` → never rely on preview aliases for this worker; go straight to the copy-worker recipe in `references/security00-upgrade-merge.md`.** After review: `wrangler delete --name <copy> --force` and restore the Access app's original `self_hosted_domains` via PUT. `git push` failing "did not receive expected object e98eeb0" = shallow clone; fix = `git fetch upstream main --unshallow && rm .git/shallow`.
- security00 fork brings: mailbox switcher + unread badges, in-app domain wizard (**Settings UI got the Auto Reply/Forwarding panels back in commit 059ced9** — the security00 upgrade merge had silently dropped them, leaving every mailbox `autoReply.enabled=false` and unable to turn on), `autoReply.dailyLimit` = per-mailbox daily cap (UTC day, **0 = unlimited**, counter in MailboxDO storage key `autoReplyCount:<date>`, lazy-pruned), in-app domain wizard (extra domains in R2 — **new domain no longer needs a redeploy**), global signature template (R2, `{{email}}/{{domain}}/{{fromName}}`), outbound attachments 25MB/file 50MB/total + paste/drag-drop + lossless image opt, Windows layout + HTML rendering fixes, `Cache-Control: no-store` on HTML.
- Upstream ships `autoReply` / `forwarding` mailbox settings as **placeholder fields with no consumer**. We wired them for real:
  - `workers/lib/auto-respond.ts` — fixed auto-reply + copy-forwarding, driven by mailbox settings JSON in R2, fire-and-forget from `receiveEmail()`.
  - Loop protection built in: never auto-responds to bounces, `no-reply` senders, `Auto-Submitted` headers, `List-Id` mail, or our own `X-Agentic-Inbox-Auto-Response` marker.
- **Sending (`workers/lib/send-provider.ts`, `sendUnified`)**: priority Resend API (`RESEND_API_KEY` secret) → CF `send_email` binding fallback (needs Workers Paid). All send sites (`index.ts`, `routes/reply-forward.ts`, `lib/tools.ts`, `lib/auto-respond.ts`) go through it.
- **Sender identity rules (deliberate, user requirement)**: `from` = bare mailbox address (`support@domain`, no display name); **replyTo is NEVER set** — user replies go straight back to `support@` → catch-all → worker. Display name optional via `{email, name}` param, stripped of `"<>` and CRLF.
- **Auth (`workers/app.ts`, dual-mode)**: `ADMIN_TOKEN` set → password login page + SHA-256 httpOnly cookie session (7d) + `Authorization: Bearer` for API/MCP; else `POLICY_AUD`+`TEAM_DOMAIN` set → Cloudflare Access JWT; neither → fail closed 500.

## Setup steps (Cloudflare side)

1. **Deploy**: `"DOMAINS": "d1.com,d2.click,..."` (comma-split; receiving is domain-agnostic) in `wrangler.jsonc`, `npm run build && npx wrangler deploy`. Wrangler auth: export `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or run `npx wrangler login`).
2. **Secrets**: `wrangler secret put RESEND_API_KEY`; `ADMIN_TOKEN` (stopgap password auth — store the token in a local file, never in chat) or `POLICY_AUD`/`TEAM_DOMAIN` (Access mode).
3. **Sending via Resend**: add each domain in Resend dashboard → 3 DNS records (SPF/DKIM) → send as `support@<domain>` from the free tier. CF `send_email` binding stays as fallback only.
4. **Per-domain Email Routing**: domain → Email → Email Routing → enable → **Catch-all → Send to a Worker → <inbox worker>**. Multiple domains → same worker.
5. **Mailboxes**: log in (ADMIN_TOKEN password page), create `support@<domain>` per domain, configure Auto Reply / Forwarding in Settings.

## Gmail "Send mail as" (replying from Gmail as support@)

Worker-side sends are already clean, but replying **from the user's Gmail** needs per-domain aliases: Gmail Settings → Accounts → Send mail as → add `support@<domain>` → SMTP `smtp.resend.com` : 465, user `resend`, password = Resend API key. Pitfalls learned: alias name must NOT be a personal name ("rapen support" came from the display-name field); leave **reply-to blank** (reply-to pointing at personal Gmail was from the alias setup); unverified aliases make Gmail fall back to the default identity. User must manually pick the right identity per reply — the worker panel avoids this (mailbox binds its own domain).

## From-zero setup flow (order matters)

1. **Deploy worker**: fill `DOMAINS` (comma-split, receiving is domain-agnostic) in `wrangler.jsonc` → `npm run build && npx wrangler deploy`.
2. **Secrets**: `wrangler secret put RESEND_API_KEY`. Auth = Access mode: `wrangler secret put POLICY_AUD` + `wrangler secret put TEAM_DOMAIN`. Then `wrangler secret delete ADMIN_TOKEN` to kill password login (dual-mode in `workers/app.ts`: ADMIN_TOKEN set → password page; else POLICY_AUD+TEAM_DOMAIN → Access JWT; neither → fail closed 500).
3. **Cloudflare Access (dashboard only — API token lacks Zero Trust write)**: Zero Trust → Access → Applications → Self-hosted, app domain = `agentic-inbox.<subdomain>.workers.dev`, policy = Emails / One-time PIN (OTP). Copy **AUD** from the app detail page; **TEAM_DOMAIN** = `https://<team>.cloudflareaccess.com` (also readable from the 302 Location header when hitting the worker unauthenticated). Verify: unauth GET `/` → **302 to Access login page** (not 500, not password page). Login = enter email → 6-digit OTP → straight into panel, no password.
4. **Resend domain verification (required before ANY outbound from that domain)**: Resend dashboard → Add Domain → 2 DNS records (SPF TXT + DKIM TXT) → paste into the domain's Cloudflare DNS → Verify. Check with `GET https://api.resend.com/domains` (Bearer key). Unverified domain = Resend rejects sends with domain-not-found. Each domain must be verified before outbound from it works.
5. **Per-domain Email Routing**: domain → Email → Email Routing → enable → Catch-all → Send to a Worker → <inbox worker>. Repeat for every domain (multiple domains → same worker).
6. **Mailboxes in panel**: log in via Access OTP → create `support@<domain>` for every domain in DOMAINS. **Mailbox must exist before mail arrives or the worker silently drops it.** Configure Auto Reply / Forwarding per mailbox in Settings.
7. **Acceptance per domain**: (a) unauth `/` → 302 → OTP page → panel; (b) inbound: external mail to `support@<domain>` appears in panel ~1min; (c) outbound: Compose → verify Resend `GET /emails/<id>` → `last_event: delivered` (cold-start spam risk, see Pitfalls); (d) optional Gmail send-as alias (section below).

## Pitfalls

- **Deliverability cold start**: new domain + new sending IP → test mail shows `delivered` in Resend but lands in Gmail/Outlook **spam**. Check Resend log (`GET /emails/<id>` → `last_event`) before blaming the send path; user marks not-spam once.
- **Sending creds in worker ≠ Gmail**: setting `RESEND_API_KEY` on the worker fixes worker sends only; Gmail replying is the separate alias setup above.
- **Cutover**: switching catch-all to the Worker kills old forwarding rules for `support@`. Export history first, switch, then external test mail.
- **`EMAIL_ADDRESSES`**: non-empty = strict allowlist (other recipients silently ignored). Leave `[]` to accept all on routed domains.
- **No IMAP/push**: native mail apps can't connect; mobile = responsive web + Add to Home Screen. For push, use Forwarding to a personal mailbox.
- **AI auto-draft ≠ auto-send**: agent drafts always need manual confirmation (upstream design).
- **CF API token lacks Zero Trust write**: a typical account API token can read Access apps/IdPs but POSTs to `access/identity_providers` return `auth.forbidden` — creating Access apps/IdPs must be done in the dashboard, not by script.
- **Preview URLs / review copies**: `versions upload --preview-alias <name>` URL is `https://<alias>-<workerName>.<accountSubdomain>.workers.dev` (dash-joined) and only serves if the version has `has_preview=true` (server decides; unreliable for DO workers — DO workers reliably get `has_preview=false`, verified 2026-09). **Proven full recipe (do all steps in order): ① deploy a copy worker: `python3`-edit `build/server/wrangler.json` → rewrite `name` (e.g. `agentic-inbox-review`), optionally trim `vars.DOMAINS`, save as `wrangler-review.json`, then `npx wrangler deploy -c wrangler-review.json`; ② enable subdomain via CF API `POST /workers/scripts/<name>/subdomain` `{"enabled": true}` (PATCH is auth-scheme-blocked); ③ new worker has NO secrets — `wrangler secret put POLICY_AUD` (copy AUD from the existing Access app) and `TEAM_DOMAIN` (readable from the prod worker's 302 Location header) else it 500s "fail closed"; ④ add the review hostname to the Access app: GET the app id from `GET /access/apps`, then **PUT** the whole app with `self_hosted_domains` including the review host (PATCH returns `auth.forbidden` 10405 for this token); unauth GET must then 302 to Access login, not 403/500. Cleanup: `wrangler delete --name <copy> --force` + restore app's `self_hosted_domains` after review.** Detail: `references/security00-upgrade-merge.md`.
- **HTTP client quirks**: `execute_code` (python urllib) to `api.resend.com` gets CF 403/1010 (TLS fingerprint block) — send Resend mail via `curl` in terminal instead; CF API GETs work fine from either.
- **Stale-SPA false alarm after deploy**: the panel is a lazily-loaded route chunk (`assets/settings-*.js`); a tab opened before the deploy keeps running the old bundle, so the user sees none of the new Settings panels. Verify server-side first (deployments API shows the new version id at 100%; grep the built chunk for the new UI text) before debugging the app — the fix is usually just "close the tab, reopen / hard refresh", not a redeploy.
- Access mode is the single trust boundary: passing it = read all mailboxes + `/mcp`. Same is true of ADMIN_TOKEN — store in a file, never paste in chat.

## Verification workflow

```bash
cd <your-agentic-inbox-repo>
npm install && npx wrangler types && npx react-router typegen
npx tsc -p tsconfig.cloudflare.json --noEmit   # clean after typegen; only noise pre-typegen
npm run build && npx wrangler deploy
```

Auth smoke test (Access mode: unauth `/` → 302 to `<team>.cloudflareaccess.com` login; OTP → panel; API/MCP without JWT → 403). Send test via curl to Resend API with `from` bare `support@<domain>`, no reply_to; verify `last_event: delivered` via `GET /emails/<id>`; then user checks inbox AND spam folder. Post-deploy acceptance per domain: inbound lands → auto-reply returns → forwarding copy arrives.
