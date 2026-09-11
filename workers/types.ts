// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	RESEND_API_KEY?: string;
	/** Comma-separated Resend API keys from multiple accounts (each account = own 3-domain free quota). */
	RESEND_API_KEYS?: string;
	/** Optional JSON map {"domain.com": "re_xxx"} pinning a domain to a specific key. */
	RESEND_DOMAIN_KEY_MAP?: string;
}
