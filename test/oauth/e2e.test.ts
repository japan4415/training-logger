import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MCP_RESOURCE, OAUTH_ISSUER } from "../../src/oauth/config.js";
import { oauthProviderOptions } from "../../src/oauth/provider.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const REDIRECT_URI = "https://chatgpt.com/callback";

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** 実 OAuthProvider のヘルパーで grant を作り、token endpoint で access token を得る。 */
async function issueAccessToken(scope: string[], userId = 1): Promise<string> {
	const helpers = getOAuthApi(
		oauthProviderOptions({ fetch: () => new Response() }),
		{
			...env,
			DB: env.DB,
		},
	);

	const client = await helpers.createClient({
		clientName: "e2e-test-client",
		redirectUris: [REDIRECT_URI],
		tokenEndpointAuthMethod: "none",
	});

	const { verifier, challenge } = await pkcePair();
	const { redirectTo } = await helpers.completeAuthorization({
		request: {
			responseType: "code",
			clientId: client.clientId,
			redirectUri: REDIRECT_URI,
			scope,
			state: "e2e-state",
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
			resource: MCP_RESOURCE,
			issuer: OAUTH_ISSUER,
		},
		userId: String(userId),
		metadata: {},
		scope,
		props: { userId },
	});

	const code = new URL(redirectTo).searchParams.get("code");
	if (!code) throw new Error(`No authorization code in ${redirectTo}`);

	const tokenResponse = await SELF.fetch(`${OAUTH_ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: client.clientId,
			redirect_uri: REDIRECT_URI,
		}),
	});
	expect(tokenResponse.status).toBe(200);
	const token = (await tokenResponse.json()) as { access_token: string };
	return token.access_token;
}

function mcpRequest(body: unknown, token?: string): Promise<Response> {
	return SELF.fetch(MCP_RESOURCE, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe("/mcp end-to-end through the OAuth provider", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(() => cleanDatabase(env.DB));

	it("serves tools/call with a token obtained from the token endpoint", async () => {
		const token = await issueAccessToken(["mcp:read", "mcp:write"]);
		const response = await mcpRequest(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "log_workout",
					arguments: {
						date: "2026-09-14",
						exercises: [{ name: "ベンチプレス", sets: [{ reps: 5 }] }],
					},
				},
			},
			token,
		);
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			result: { content: Array<{ text: string }>; isError?: boolean };
		};
		expect(data.result.isError).toBeUndefined();
		expect(JSON.parse(data.result.content[0].text).sets_logged).toBe(1);
	});

	it("returns 403 insufficient_scope when the token lacks the tool scope", async () => {
		const token = await issueAccessToken(["mcp:read"]);
		const response = await mcpRequest(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "log_workout",
					arguments: {
						date: "2026-09-14",
						exercises: [{ name: "ベンチプレス" }],
					},
				},
			},
			token,
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate") ?? "").toContain(
			'scope="mcp:write"',
		);
	});
});
