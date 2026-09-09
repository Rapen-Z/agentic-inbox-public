// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Auth middleware (production): ADMIN_TOKEN password login OR Cloudflare Access JWT.
// Mode is chosen by which secrets are set:
//   ADMIN_TOKEN set            -> simple bearer/session-password auth (bootstrap / stopgap)
//   POLICY_AUD+TEAM_DOMAIN set -> Cloudflare Access JWT validation (standard, preferred)
//   neither                    -> fail closed
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN, ADMIN_TOKEN } = c.env;

	// Mode 1: simple admin token auth (stopgap until Cloudflare Access is configured)
	if (ADMIN_TOKEN) {
		if (c.req.path === "/auth/login") return next(); // login endpoint itself is open
		if (c.req.method === "OPTIONS") return next(); // CORS preflight carries no auth

		// Expected credential for both header and cookie comparisons.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ADMIN_TOKEN));
		const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

		const header =
			c.req.header("authorization") ||
			c.req.header("x-admin-token") ||
			c.req.header("cf-access-jwt-assertion");
		const cookies = Object.fromEntries(
			(c.req.header("cookie") || "").split(";").map((p) => p.trim().split("=", 2)).filter((p) => p.length === 2),
		);
		if (header === `Bearer ${ADMIN_TOKEN}` || header === ADMIN_TOKEN || cookies["agentic_auth"] === expected) {
			return next();
		}
		// API clients (MCP, agent tools) authenticate via header; browsers get the login page.
		const isApi =
			c.req.path.startsWith("/api/") || c.req.path.startsWith("/mcp");
		if (isApi) {
			return c.text("Unauthorized: pass Authorization: Bearer <ADMIN_TOKEN>", 401);
		}
		return c.html(
			`<!doctype html><html><head><meta charset="utf-8"><title>Login</title>` +
			`<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
			`<body style="font-family:system-ui;background:#0f1117;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
			`<form method="POST" action="/auth/login" style="background:#1a1d27;padding:2rem;border-radius:12px;min-width:320px">` +
			`<h2 style="margin:0 0 1rem">🔐 Agentic Inbox</h2>` +
			`<input type="password" name="token" placeholder="Admin token" required ` +
			`style="width:100%;padding:.6rem;border-radius:8px;border:1px solid #33363f;background:#0f1117;color:#e6e6e6;box-sizing:border-box">` +
			`<button type="submit" style="margin-top:1rem;width:100%;padding:.6rem;border-radius:8px;border:0;background:#4f7cff;color:#fff;font-weight:600;cursor:pointer">Sign in</button>` +
			`</form></body></html>`,
			401,
		);
	}

	// Mode 2: Cloudflare Access JWT validation (standard path)
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN (or ADMIN_TOKEN as a stopgap).",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// Admin-token login: sets an httpOnly session cookie (SHA-256 of ADMIN_TOKEN).
// Only active when ADMIN_TOKEN is configured (stopgap before Cloudflare Access).
app.post("/auth/login", async (c) => {
	const { ADMIN_TOKEN } = c.env;
	const form = await c.req.parseBody();
	const token = typeof form.token === "string" ? form.token : "";
	if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
		return c.text("Invalid token", 403);
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ADMIN_TOKEN));
	const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	c.header(
		"Set-Cookie",
		`agentic_auth=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
	);
	return c.redirect("/");
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
