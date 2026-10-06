/**
 * Issue #66 Phase 4: RFC 7591 Dynamic Client Registration（任意・既定で無効）。
 *
 * ChatGPT / claude.ai は Client ID Metadata Document（CIMD）で接続できるため、
 * 既定では DCR を公開しない（KV への書き込み濫用 DoS を避ける）。
 * `OAUTH_DCR_ENABLED=1` のときだけ `POST /oauth/register` を有効にし、
 * redirect_uri のホスト許可リストで登録を制限する。
 *
 * Rate limiting はアプリ側では行わず、Cloudflare の Rate Limiting ルール（または
 * WAF）で `/oauth/register` を制限する運用とする（人手の作業）。
 */

import type { Context, Hono } from "hono";
import type { AppEnv } from "../env.js";
import { allowedRedirectHosts, isAllowedRedirectUri } from "./config.js";

function registrationError(
	c: Context<AppEnv>,
	status: number,
	description: string,
) {
	return c.json(
		{ error: "invalid_client_metadata", error_description: description },
		status as never,
	);
}

function stringField(
	metadata: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function registerDcrRoutes(app: Hono<AppEnv>): void {
	app.post("/oauth/register", async (c) => {
		if (c.env.OAUTH_DCR_ENABLED !== "1") {
			return c.json({ error: "not_found" }, 404);
		}
		const oauth = c.env.OAUTH_PROVIDER;
		if (!oauth) return c.json({ error: "server_error" }, 500);

		let payload: unknown;
		try {
			payload = await c.req.json();
		} catch {
			return registrationError(c, 400, "Request body must be valid JSON");
		}
		if (typeof payload !== "object" || payload === null) {
			return registrationError(c, 400, "Request body must be a JSON object");
		}
		const metadata = payload as Record<string, unknown>;
		const redirectUris = Array.isArray(metadata.redirect_uris)
			? metadata.redirect_uris.filter(
					(value): value is string => typeof value === "string",
				)
			: [];
		if (redirectUris.length === 0) {
			return registrationError(c, 400, "redirect_uris is required");
		}
		const allowed = allowedRedirectHosts(c.env.OAUTH_ALLOWED_REDIRECT_HOSTS);
		if (!redirectUris.every((uri) => isAllowedRedirectUri(uri, allowed))) {
			return registrationError(
				c,
				400,
				"redirect_uris must use a host on this server's allowlist",
			);
		}

		try {
			const client = await oauth.createClient({
				clientName: stringField(metadata, "client_name"),
				clientUri: stringField(metadata, "client_uri"),
				logoUri: stringField(metadata, "logo_uri"),
				redirectUris,
				// 招待制の個人向けサーバーなので公開クライアント（PKCE 必須）だけ登録する。
				tokenEndpointAuthMethod: "none",
				grantTypes: ["authorization_code", "refresh_token"],
				responseTypes: ["code"],
			});
			return c.json(
				{
					client_id: client.clientId,
					client_id_issued_at: Math.floor(Date.now() / 1000),
					client_name: client.clientName ?? null,
					redirect_uris: client.redirectUris,
					token_endpoint_auth_method: client.tokenEndpointAuthMethod,
					grant_types: client.grantTypes ?? [
						"authorization_code",
						"refresh_token",
					],
					response_types: client.responseTypes ?? ["code"],
				},
				201,
			);
		} catch (error) {
			// createClient は redirect URI ポリシー違反などで例外を投げる。詳細は返さない。
			console.error("Dynamic client registration failed", error);
			return registrationError(c, 400, "client metadata was rejected");
		}
	});
}
