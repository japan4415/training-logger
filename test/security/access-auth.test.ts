import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env.js";
import {
	requireAccessUser,
	requireAccessUserForRead,
} from "../../src/security/access-auth.js";

const DOMAIN = "team.cloudflareaccess.com";
const ISSUER = `https://${DOMAIN}`;
const AUDIENCE = "test-audience";
const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };
let keys: CryptoKeyPair;
let publicJwk: JsonWebKey;

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

async function jwt(
	payload: Record<string, unknown>,
	headerOverrides: Record<string, unknown> = {},
): Promise<string> {
	const header = base64Url(
		new TextEncoder().encode(
			JSON.stringify({ alg: "RS256", kid: "key-1", ...headerOverrides }),
		),
	);
	const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		keys.privateKey,
		new TextEncoder().encode(`${header}.${body}`),
	);
	return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

function appFor(fetchFn: typeof fetch) {
	const app = new Hono<{ Bindings: Bindings }>();
	app.post("/write", async (c) => {
		const auth = await requireAccessUser(c, fetchFn);
		if (!auth.ok) return auth.response;
		return c.json({ ok: true });
	});
	app.get("/read", async (c) => {
		const auth = await requireAccessUserForRead(c, fetchFn);
		if (!auth.ok) return auth.response;
		return c.json({ ok: true });
	});
	return app;
}

function bindings(): Bindings {
	return {
		DB: {} as D1Database,
		PHOTOS: {} as R2Bucket,
		ACCESS_TEAM_DOMAIN: DOMAIN,
		ACCESS_AUD: AUDIENCE,
	};
}

describe("Cloudflare Access authentication", () => {
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
	});

	function jwksFetch() {
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

	it("accepts a valid signed JWT with matching audience", async () => {
		const fetchFn = jwksFetch();
		const token = await jwt({
			sub: "user-id",
			aud: AUDIENCE,
			iss: ISSUER,
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const response = await appFor(fetchFn).request(
			"/write",
			{
				method: "POST",
				headers: { ...SAME_ORIGIN, "Cf-Access-Jwt-Assertion": token },
			},
			bindings(),
		);
		expect(response.status).toBe(200);
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(fetchFn).toHaveBeenCalledWith(
			`https://${DOMAIN}/cdn-cgi/access/certs`,
		);
	});

	it("authenticates reads without requiring Fetch Metadata", async () => {
		const fetchFn = jwksFetch();
		const token = await jwt({
			sub: "user-id",
			aud: AUDIENCE,
			iss: ISSUER,
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const response = await appFor(fetchFn).request(
			"/read",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			bindings(),
		);
		expect(response.status).toBe(200);
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("reuses a fetched JWKS for the same signing key", async () => {
		const fetchFn = jwksFetch();
		const token = await jwt({
			sub: "user-id",
			aud: AUDIENCE,
			iss: ISSUER,
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const app = appFor(fetchFn);
		for (let index = 0; index < 2; index++) {
			const response = await app.request(
				"/read",
				{ headers: { "Cf-Access-Jwt-Assertion": token } },
				bindings(),
			);
			expect(response.status).toBe(200);
		}
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"expired",
			{ aud: AUDIENCE, iss: ISSUER, exp: Math.floor(Date.now() / 1000) - 1 },
		],
		[
			"audience mismatch",
			{
				aud: "different",
				iss: ISSUER,
				exp: Math.floor(Date.now() / 1000) + 60,
			},
		],
	] as const)("rejects %s JWT", async (_name, payload) => {
		const response = await appFor(jwksFetch()).request(
			"/write",
			{
				method: "POST",
				headers: {
					...SAME_ORIGIN,
					"Cf-Access-Jwt-Assertion": await jwt(payload),
				},
			},
			bindings(),
		);
		expect(response.status).toBe(401);
	});

	it("rejects an invalid signature", async () => {
		const valid = await jwt({
			aud: AUDIENCE,
			iss: ISSUER,
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const parts = valid.split(".");
		parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
		const response = await appFor(jwksFetch()).request(
			"/write",
			{
				method: "POST",
				headers: {
					...SAME_ORIGIN,
					"Cf-Access-Jwt-Assertion": parts.join("."),
				},
			},
			bindings(),
		);
		expect(response.status).toBe(401);
	});

	it.each([
		["none", { alg: "none" }],
		["HS256", { alg: "HS256" }],
	] as const)(
		"rejects a JWT whose header alg is %s without fetching JWKS",
		async (_name, header) => {
			const fetchFn = jwksFetch();
			const token = await jwt(
				{
					sub: "user-id",
					aud: AUDIENCE,
					iss: ISSUER,
					exp: Math.floor(Date.now() / 1000) + 60,
				},
				header,
			);
			const response = await appFor(fetchFn).request(
				"/write",
				{
					method: "POST",
					headers: {
						...SAME_ORIGIN,
						"Cf-Access-Jwt-Assertion": token,
					},
				},
				bindings(),
			);
			expect(response.status).toBe(401);
			expect(fetchFn).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a mismatched issuer", { iss: "https://evil.cloudflareaccess.com" }],
		["a missing issuer", {}],
	] as const)(
		"rejects a JWT with %s without fetching JWKS",
		async (_name, overrides) => {
			const fetchFn = jwksFetch();
			const token = await jwt({
				sub: "user-id",
				aud: AUDIENCE,
				exp: Math.floor(Date.now() / 1000) + 60,
				...overrides,
			});
			const response = await appFor(fetchFn).request(
				"/write",
				{
					method: "POST",
					headers: {
						...SAME_ORIGIN,
						"Cf-Access-Jwt-Assertion": token,
					},
				},
				bindings(),
			);
			expect(response.status).toBe(401);
			expect(fetchFn).not.toHaveBeenCalled();
		},
	);

	it("rejects a JWT that is not yet valid (future nbf)", async () => {
		const fetchFn = jwksFetch();
		const token = await jwt({
			sub: "user-id",
			aud: AUDIENCE,
			iss: ISSUER,
			nbf: Math.floor(Date.now() / 1000) + 3600,
			exp: Math.floor(Date.now() / 1000) + 7200,
		});
		const response = await appFor(fetchFn).request(
			"/write",
			{
				method: "POST",
				headers: { ...SAME_ORIGIN, "Cf-Access-Jwt-Assertion": token },
			},
			bindings(),
		);
		expect(response.status).toBe(401);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("does not refetch JWKS for an unknown kid within the refetch interval", async () => {
		const fetchFn = jwksFetch();
		const token = await jwt(
			{
				sub: "user-id",
				aud: AUDIENCE,
				iss: ISSUER,
				exp: Math.floor(Date.now() / 1000) + 60,
			},
			{ kid: "rotated-key" },
		);
		const app = appFor(fetchFn);
		for (let index = 0; index < 3; index++) {
			const response = await app.request(
				"/read",
				{ headers: { "Cf-Access-Jwt-Assertion": token } },
				bindings(),
			);
			expect(response.status).toBe(401);
		}
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("refetches JWKS after the refetch interval to pick up a rotated key", async () => {
		const baseTime = Date.parse("2026-01-01T00:00:00Z");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);
		try {
			let calls = 0;
			const fetchFn = (async () => {
				calls += 1;
				const kid = calls === 1 ? "key-1" : "key-2";
				return new Response(
					JSON.stringify({
						keys: [{ ...publicJwk, kid, alg: "RS256" }],
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;
			const token = await jwt(
				{
					sub: "user-id",
					aud: AUDIENCE,
					iss: ISSUER,
					exp: Math.floor(baseTime / 1000) + 3600,
				},
				{ kid: "key-2" },
			);
			const app = appFor(fetchFn);

			const before = await app.request(
				"/read",
				{ headers: { "Cf-Access-Jwt-Assertion": token } },
				bindings(),
			);
			expect(before.status).toBe(401);
			expect(calls).toBe(1);

			nowSpy.mockReturnValue(baseTime + 31_000);
			const after = await app.request(
				"/read",
				{ headers: { "Cf-Access-Jwt-Assertion": token } },
				bindings(),
			);
			expect(after.status).toBe(200);
			expect(calls).toBe(2);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("rejects a request without a JWT header or cookie", async () => {
		const fetchFn = jwksFetch();
		const response = await appFor(fetchFn).request(
			"/write",
			{ method: "POST", headers: SAME_ORIGIN },
			bindings(),
		);
		expect(response.status).toBe(401);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("rejects writes when Sec-Fetch-Site is missing", async () => {
		const response = await appFor(jwksFetch()).request(
			"/write",
			{ method: "POST" },
			bindings(),
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("csrf_forbidden");
	});

	it.each(["http://localhost:8787/write", "http://127.0.0.1:8787/write"])(
		"allows the local unauthenticated flag for %s",
		async (url) => {
			const response = await appFor(jwksFetch()).request(
				url,
				{ method: "POST", headers: SAME_ORIGIN },
				{
					...bindings(),
					ACCESS_TEAM_DOMAIN: undefined,
					ACCESS_AUD: undefined,
					PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
				},
			);
			expect(response.status).toBe(200);
		},
	);

	it("ignores the local unauthenticated flag on a non-local host", async () => {
		const response = await appFor(jwksFetch()).request(
			"https://training-logger.discord.jp/write",
			{ method: "POST", headers: SAME_ORIGIN },
			{
				...bindings(),
				ACCESS_TEAM_DOMAIN: undefined,
				ACCESS_AUD: undefined,
				PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
			},
		);
		expect(response.status).toBe(401);
		expect((await response.json()).error).toBe("access_not_configured");
	});
});
