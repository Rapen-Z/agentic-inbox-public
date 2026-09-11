# security00 Upgrade Merge — Send Stack Comparison & Review-Copy Recipe

Merge window: 2026-09-10/11. Upstream UI taken wholesale; our `sendUnified` + auto-respond + auth middleware kept.

## Send stack comparison (why Resend primary / CF binding fallback)

| | CF `send_email` binding (security00 style) | Resend (our `sendUnified` primary) |
|---|---|---|
| Free tier | ❌ arbitrary recipients need Workers Paid ($5/mo); free plan only sends to verified destination addresses (= basically yourself) | ✅ 3,000 emails/mo (100/day) |
| Overage | $0.35 / 1,000 emails | $20/mo from 50k |
| Cold start | account-level daily quota; new accounts tight | works immediately after domain SPF/DKIM verify |

security00's own outbound was pure `env.EMAIL.send()`; commit `d9b09b5` (their fork, not upstream) let other Workers call its send API via service binding without Access JWT — designed for Worker-to-Worker internal sends like password-reset mail. We merge their UI/features but keep Resend as the send path.

## Auto-reply daily limit (commit 059ced9, 2026-09-11)

- `autoReply.dailyLimit` per mailbox (UTC-day bucket, **0/undefined = unlimited**).
- Counter in `MailboxDO` ctx.storage: key `autoReplyCount:<YYYY-MM-DD>`, stale keys pruned on read (`getAutoReplyCountToday` / `incrementAutoReplyCount`).
- Check happens before `sendUnified`, increment after successful send — so a failed send doesn't burn quota.
- Settings UI panels (Auto Reply + Forwarding) were dropped during the security00 merge → every existing mailbox had `autoReply.enabled=false` with no way to enable. 059ced9 restores both panels; new mailboxes seed `dailyLimit: 0`.

## Review-copy recipe (copy worker — the reliable path for this DO worker)

`versions upload --preview-alias` on this DO worker always returns `has_preview:false` → alias 404s; do not spend a cycle re-testing it. Full working recipe (order matters):

1. `npm run build` → edit `build/server/wrangler.json`: rewrite `name` (e.g. `agentic-inbox-review`), trim `vars.DOMAINS` if desired, save as `wrangler-review.json` (keep `main: index.js`, `no_bundle: true` as emitted).
2. `npx wrangler deploy -c wrangler-review.json` → URL `https://agentic-inbox-review.<acct>.workers.dev`.
3. Enable subdomain: `POST /workers/scripts/<name>/subdomain` `{"enabled": true}` (PATCH blocked).
4. Secrets (new worker has none; without them it 500s "Access must be configured"): `wrangler secret put POLICY_AUD` (copy AUD from existing Access app — readable via `GET /access/apps`) + `wrangler secret put TEAM_DOMAIN` (readable from prod worker's 302 Location header).
5. Access app membership: `GET /access/apps` → find app id → **PUT** full app JSON with `self_hosted_domains` array extended with the review host (PATCH → error 10405 `Method not allowed for this authentication scheme`).
6. Acceptance: unauth GET `/` → 302 to `<team>.cloudflareaccess.com` login (403 = not in app yet, 500 = secrets missing).
7. Cleanup after review: `npx wrangler delete --name <copy> --force` + PUT the Access app back with original `self_hosted_domains`.

## Deploy smoke test (post `wrangler deploy`)

1. `GET /access/apps` → confirm AUD unchanged; deployments API → new version id at 100%.
2. Unauth GET `/` → must be 302 to Access login (500 = secrets wiped, 403 = hostname not in `self_hosted_domains`).
3. Grep the built `build/client/assets/settings-*.js` for the new UI strings when a settings-page change ships — confirms the right chunk is in the bundle before the user checks.

