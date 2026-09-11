# agentic-inbox: sending via Resend + dual-mode auth (session 2026-09-09)

Verified implementation detail for the send-provider and auth patches. Source: `/root/projects/agentic-inbox-src/agentic-inbox` (commits `bfd391a` sending, `9e6e47d` auth).

## send-provider.ts contract

```ts
sendUnified(env: { EMAIL?: SendEmail; RESEND_API_KEY?: string }, params: UnifiedSendParams)
  -> { messageId, provider: "resend" | "cf" }
```

- Resend POST `https://api.resend.com/emails` with `{from, to[], subject, html?, text?, cc?, bcc?, headers?, attachments?}`.
- `headers` (threading: In-Reply-To/References) passed through as RFC 5322 headers — replies thread correctly in Gmail/Outlook.
- `from` accepts `string` or `{email, name}`; display name formatted `"name" <email>` with `"<>` and CR/LF stripped.
- **replyTo deliberately never set** — user requirement: replies must land back on `support@domain` (worker inbox), never a personal Gmail.
- Fallback: Resend failure + `EMAIL` binding present → CF send_email (console.warn, then CF); no provider configured → throw.
- All 5 send sites converted: `index.ts` (compose), `routes/reply-forward.ts` (reply+forward x2), `lib/tools.ts` (agent reply + agent send_email), `lib/auto-respond.ts` (fixed auto-reply + forwarding copy).

## Dual-mode auth middleware (workers/app.ts)

Mode selection by secrets: `ADMIN_TOKEN` → mode 1; else `POLICY_AUD`+`TEAM_DOMAIN` → Access JWT; neither → 500 fail closed.

Mode 1 (stopgap):
- `/auth/login` path + OPTIONS preflight bypass middleware.
- Accepted credentials: `Authorization: Bearer <ADMIN_TOKEN>`, `X-Admin-Token` header, `cf-access-jwt-assertion` header, or `agentic_auth` cookie == SHA-256(ADMIN_TOKEN) hex.
- Browser unauth → 401 inline HTML login page (dark theme, posts `token` field to `/auth/login`); API/MCP paths (`/api/*`, `/mcp*`) → plain 401 text.
- `POST /auth/login`: verify token, `Set-Cookie agentic_auth=<sha256>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`, redirect `/`.
- Cookie never stores the token itself — stores its SHA-256 so log leaks ≠ credential leak.
- `Env` gained `RESEND_API_KEY?` and `ADMIN_TOKEN?` in `workers/types.ts`.

Verified smoke results: unauth `/` → 401 login HTML ✓; correct login POST → cookie set, redirect ✓; cookie'd `/` → 200 app ✓; wrong token → 403 ✓.

## Deploy/ops facts

- Wrangler unauthenticated by default → export `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or `npx wrangler login`) before any deploy/secret command.
- Secrets: `RESEND_API_KEY` from `/root/projects/agentic-inbox-src/.env.resend`; `ADMIN_TOKEN` stored at `/root/projects/agentic-inbox-src/.admin_token` (48-hex, generated `openssl rand -hex 24`).
- Resend sends from sandbox: `execute_code`/python urllib → 403 error 1010 (CF TLS fingerprint block); **curl in terminal works**. Resend log check: `GET /emails/<id>` → `last_event`.
- CF API token can READ Access apps/IdPs but writes return `auth.forbidden` — Access setup is dashboard-only.
- Deployed versions: sending `14827828-…`, auth `9e6e47d` → `9fabeaee-…`.
- Pending when Access is adopted: dashboard create Access app on `agentic-inbox.<your-subdomain>.workers.dev`, get AUD tag + team domain → `wrangler secret put POLICY_AUD`/`TEAM_DOMAIN`. Mode order in code: **ADMIN_TOKEN wins if set** (checked first) — so `wrangler secret delete ADMIN_TOKEN` is required to actually switch to Access mode after setting the Access secrets.
