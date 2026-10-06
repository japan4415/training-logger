import { env } from "cloudflare:test";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_IDENTITY_PROVIDER } from "../../src/db/users.js";
import type { AppEnv, Bindings } from "../../src/env.js";
import { registerAuthorizeRoutes } from "../../src/oauth/authorize.js";
import { MCP_RESOURCE, OAUTH_ISSUER } from "../../src/oauth/config.js";
import { createConsentCsrfToken } from "../../src/oauth/csrf.js";
import { registerAccessAuth } from "../../src/security/auth.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const DOMAIN = "team.cloudflareaccess.com";
const ISSUER = `https://${DOMAIN}`;
const AUDIENCE = "test-audience";
const CONSENT_SECRET = "s".repeat(64);

const AUTH_REQUEST = {
	responseType: "code",
	clientId: "https://claude.ai/client.json",
	redirectUri: "https://chatgpt.com/callback",
	scope: ["mcp:read"],
	state: "state-1",
	codeChallenge: "challenge",
	codeChallengeMethod: "S256",
	resource: MCP_RESOURCE,
	issuer: OAUTH_ISSUER,
};

let keys: CryptoKeyPair;
let publicJwk: JsonWebKey;

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

async function validJwt(sub: string): Promise<string> {
	const header = base64Url(
		new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "key-1" })),
	);
	const body = base64Url(
		new TextEncoder().encode(
			JSON.stringify({
				sub,
				aud: AUDIENCE,
				iss: ISSUER,
				exp: Math.floor(Date.now() / 1000) + 60,
			}),
		),
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		keys.privateKey,
		new TextEncoder().encode(`${header}.${body}`),
	);
	return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

function jwksFetch(): typeof fetch {
	return vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					keys: [{ ...publicJwk, kid: "key-1", alg: "RS256" }],
				}),
				{ status: 200 },
			),
	) as unknown as typeof fetch;
}

function fakeOAuth(parseResult: unknown = AUTH_REQUEST): OAuthHelpers {
	return {
		parseAuthRequest: vi.fn(async () => parseResult),
		describeConsent: vi.fn(async () => ({
			clientId: AUTH_REQUEST.clientId,
			clientName: "Claude",
			clientDomain: "claude.ai",
			redirectUri: AUTH_REQUEST.redirectUri,
			redirectHost: "chatgpt.com",
			redirectIsLoopback: false,
			scope: [...AUTH_REQUEST.scope],
		})),
		beginConsent: vi.fn(async () => ({
			handle: "handle-1",
			headers: new Headers({
				"Cache-Control": "no-store",
				"Set-Cookie": "__Host-oauth-consent-1=abc; Path=/",
			}),
		})),
		approveConsent: vi.fn(async (_req, _handle, options) => ({
			request: { ...AUTH_REQUEST, scope: options?.scope ?? AUTH_REQUEST.scope },
			headers: new Headers({ "Cache-Control": "no-store" }),
		})),
		denyConsent: vi.fn(async () => ({
			request: AUTH_REQUEST,
			redirectTo: `${AUTH_REQUEST.redirectUri}?error=access_denied&state=state-1`,
			headers: new Headers({
				Location: `${AUTH_REQUEST.redirectUri}?error=access_denied&state=state-1`,
			}),
		})),
		completeAuthorization: vi.fn(async () => ({
			redirectTo: `${AUTH_REQUEST.redirectUri}?code=code-1&state=state-1`,
		})),
	} as unknown as OAuthHelpers;
}

function appWith(oauth: OAuthHelpers): Hono<AppEnv> {
	activeOAuth = oauth;
	const app = new Hono<AppEnv>();
	registerAccessAuth(app, jwksFetch());
	registerAuthorizeRoutes(app);
	return app;
}

/** `appWith` が直近に設定した OAuth ヘルパーを bindings に載せる。 */
let activeOAuth: OAuthHelpers | undefined;

function bindings(overrides: Partial<Bindings> = {}): Bindings {
	return {
		DB: env.DB,
		PHOTOS: env.PHOTOS,
		ACCESS_TEAM_DOMAIN: DOMAIN,
		ACCESS_AUD: AUDIENCE,
		OAUTH_CONSENT_SECRET: CONSENT_SECRET,
		OAUTH_PROVIDER: activeOAuth,
		...overrides,
	};
}

async function getAuthorize(
	app: Hono<AppEnv>,
	envOverrides: Partial<Bindings>,
	token?: string,
): Promise<Response> {
	return app.request(
		"/authorize",
		{ headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} },
		bindings(envOverrides),
	);
}

async function postAuthorize(
	app: Hono<AppEnv>,
	envOverrides: Partial<Bindings>,
	form: Record<string, string>,
	token?: string,
): Promise<Response> {
	return app.request(
		"/authorize",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Sec-Fetch-Site": "same-origin",
				...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
			},
			body: new URLSearchParams(form).toString(),
		},
		bindings(envOverrides),
	);
}

async function seedUser(id: number, subject: string): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (?, NULL, 'active', 'member')",
		).bind(id),
		env.DB.prepare(
			"INSERT INTO user_identities (user_id, provider, subject) VALUES (?, ?, ?)",
		).bind(id, ACCESS_IDENTITY_PROVIDER, subject),
	]);
}

describe("/authorize consent flow", () => {
	beforeAll(async () => {
		keys = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await seedUser(7, "subject-7");
	});

	describe("GET /authorize", () => {
		it("renders the consent page with a CSRF token and frame-ancestors CSP", async () => {
			const oauth = fakeOAuth();
			const response = await getAuthorize(
				appWith(oauth),
				{},
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Security-Policy")).toBe(
				"frame-ancestors 'none'",
			);
			const html = await response.text();
			expect(html).toContain("Claude");
			expect(html).toContain('name="handle"');
			expect(html).toContain('value="handle-1"');
			expect(html).toContain('name="csrf"');
			expect(html).toContain("chatgpt.com");
			expect(html).toContain("mcp:read");
		});

		it("rejects a redirect host outside the allowlist", async () => {
			const oauth = fakeOAuth({
				...AUTH_REQUEST,
				clientId: "https://evil.example/client.json",
				redirectUri: "https://evil.example/cb",
			});
			const response = await getAuthorize(
				appWith(oauth),
				{},
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("許可されていません");
		});

		it("fails closed on a production host without OAUTH_CONSENT_SECRET", async () => {
			const oauth = fakeOAuth();
			const response = await getAuthorize(
				appWith(oauth),
				{ OAUTH_CONSENT_SECRET: undefined },
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(503);
			expect(oauth.parseAuthRequest).not.toHaveBeenCalled();
		});

		it("uses the local development fallback secret only under the dev condition", async () => {
			const oauth = fakeOAuth();
			const response = await appWith(oauth).request(
				"http://localhost/authorize",
				{},
				{
					DB: env.DB,
					PHOTOS: env.PHOTOS,
					PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
					OAUTH_PROVIDER: oauth,
				},
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("Claude");
		});
	});

	describe("POST /authorize", () => {
		it("approves with a valid CSRF token and binds the internal user id", async () => {
			const oauth = fakeOAuth();
			const app = appWith(oauth);
			const csrf = await createConsentCsrfToken(
				"subject-7",
				"handle-1",
				CONSENT_SECRET,
			);
			const response = await postAuthorize(
				app,
				{},
				{ handle: "handle-1", csrf, decision: "approve", scope: "mcp:read" },
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("code=code-1");
			expect(oauth.completeAuthorization).toHaveBeenCalledWith(
				expect.objectContaining({ userId: "7", props: { userId: 7 } }),
			);
		});

		it("rejects a missing or mismatched CSRF token", async () => {
			const app = appWith(fakeOAuth());
			const token = await validJwt("subject-7");
			for (const csrf of ["", "not-the-token"]) {
				const response = await postAuthorize(
					app,
					{},
					{ handle: "handle-1", csrf, decision: "approve" },
					token,
				);
				expect(response.status).toBe(403);
			}
		});

		it("rejects a CSRF token bound to a different Access subject", async () => {
			const app = appWith(fakeOAuth());
			const csrf = await createConsentCsrfToken(
				"subject-other",
				"handle-1",
				CONSENT_SECRET,
			);
			const response = await postAuthorize(
				app,
				{},
				{ handle: "handle-1", csrf, decision: "approve" },
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(403);
		});

		it("fails closed when OAUTH_CONSENT_SECRET is missing", async () => {
			const response = await postAuthorize(
				appWith(fakeOAuth()),
				{ OAUTH_CONSENT_SECRET: undefined },
				{ handle: "handle-1", csrf: "anything", decision: "approve" },
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(503);
		});

		it("denies with a redirect to the client when the user declines", async () => {
			const oauth = fakeOAuth();
			const csrf = await createConsentCsrfToken(
				"subject-7",
				"handle-1",
				CONSENT_SECRET,
			);
			const response = await postAuthorize(
				appWith(oauth),
				{},
				{ handle: "handle-1", csrf, decision: "deny" },
				await validJwt("subject-7"),
			);
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toContain("error=access_denied");
			expect(oauth.denyConsent).toHaveBeenCalled();
			expect(oauth.completeAuthorization).not.toHaveBeenCalled();
		});
	});
});
