import type { Context } from "hono";
import type { Bindings } from "../env.js";

type FetchFn = typeof fetch;

interface JwtHeader {
	alg?: string;
	kid?: string;
}

interface JwtPayload {
	aud?: string | string[];
	exp?: number;
	sub?: string;
	email?: string;
}

interface JwksResponse {
	keys?: Array<JsonWebKey & { kid?: string }>;
}

interface CachedJwk {
	jwk: JsonWebKey;
	expiresAt: number;
}

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const jwksCaches = new WeakMap<FetchFn, Map<string, CachedJwk>>();
const pendingJwksRequests = new WeakMap<FetchFn, Map<string, Promise<void>>>();

async function getAccessJwk(
	teamDomain: string,
	kid: string,
	fetchFn: FetchFn,
): Promise<JsonWebKey> {
	let cache = jwksCaches.get(fetchFn);
	if (!cache) {
		cache = new Map();
		jwksCaches.set(fetchFn, cache);
	}
	const cacheKey = `${teamDomain}\u0000${kid}`;
	const cached = cache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.jwk;
	cache.delete(cacheKey);

	let pendingByDomain = pendingJwksRequests.get(fetchFn);
	if (!pendingByDomain) {
		pendingByDomain = new Map();
		pendingJwksRequests.set(fetchFn, pendingByDomain);
	}
	let pending = pendingByDomain.get(teamDomain);
	if (!pending) {
		pending = (async () => {
			const response = await fetchFn(
				`https://${teamDomain}/cdn-cgi/access/certs`,
			);
			if (!response.ok) throw new Error("Unable to fetch Access JWKS");
			const jwks = (await response.json()) as JwksResponse;
			const expiresAt = Date.now() + JWKS_CACHE_TTL_MS;
			for (const jwk of jwks.keys ?? []) {
				if (jwk.kid) {
					cache.set(`${teamDomain}\u0000${jwk.kid}`, { jwk, expiresAt });
				}
			}
		})();
		pendingByDomain.set(teamDomain, pending);
	}
	try {
		await pending;
	} finally {
		if (pendingByDomain.get(teamDomain) === pending) {
			pendingByDomain.delete(teamDomain);
		}
	}

	const fetched = cache.get(cacheKey);
	if (!fetched) throw new Error("JWT signing key not found");
	return fetched.jwk;
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid JWT encoding");
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const decoded = atob(padded);
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeJsonPart<T>(value: string): T {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function audienceMatches(
	actual: string | string[] | undefined,
	expected: string,
) {
	return typeof actual === "string"
		? actual === expected
		: Array.isArray(actual) && actual.includes(expected);
}

/** Verify one Cloudflare Access JWT against the application's JWKS. */
export async function verifyAccessJwt(
	token: string,
	teamDomain: string,
	audience: string,
	fetchFn: FetchFn = fetch,
): Promise<JwtPayload> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid JWT");
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = decodeJsonPart<JwtHeader>(encodedHeader);
	const payload = decodeJsonPart<JwtPayload>(encodedPayload);
	if (header.alg !== "RS256" || !header.kid) {
		throw new Error("Unsupported JWT algorithm");
	}
	if (
		typeof payload.exp !== "number" ||
		!Number.isFinite(payload.exp) ||
		payload.exp <= Date.now() / 1000
	) {
		throw new Error("JWT expired");
	}
	if (!audienceMatches(payload.aud, audience)) {
		throw new Error("JWT audience mismatch");
	}

	const jwk = await getAccessJwk(teamDomain, header.kid, fetchFn);

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
	const signature = decodeBase64Url(encodedSignature);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		signature,
		data,
	);
	if (!valid) throw new Error("Invalid JWT signature");
	return payload;
}

function cookieValue(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === name) {
			return part.slice(separator + 1).trim();
		}
	}
	return null;
}

export type AccessAuthResult =
	| { ok: true; user: JwtPayload | null }
	| { ok: false; response: Response };

async function authenticateAccessUser(
	c: Context<{ Bindings: Bindings }>,
	fetchFn: FetchFn = fetch,
): Promise<AccessAuthResult> {
	const { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: audience } = c.env;
	if (!domain || !audience) {
		const hostname = new URL(c.req.url).hostname.toLowerCase();
		if (
			c.env.PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED === "1" &&
			(hostname === "localhost" || hostname === "127.0.0.1")
		) {
			return { ok: true, user: null };
		}
		return {
			ok: false,
			response: c.json({ error: "access_not_configured" }, 401),
		};
	}

	const token =
		c.req.header("Cf-Access-Jwt-Assertion") ??
		cookieValue(c.req.header("Cookie"), "CF_Authorization");
	if (!token) {
		return { ok: false, response: c.json({ error: "unauthorized" }, 401) };
	}

	try {
		const user = await verifyAccessJwt(token, domain, audience, fetchFn);
		return { ok: true, user };
	} catch {
		return { ok: false, response: c.json({ error: "unauthorized" }, 401) };
	}
}

/** Apply Fetch Metadata CSRF checks and Cloudflare Access authentication. */
export async function requireAccessUser(
	c: Context<{ Bindings: Bindings }>,
	fetchFn: FetchFn = fetch,
): Promise<AccessAuthResult> {
	const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
	if (!fetchSite || (fetchSite !== "same-origin" && fetchSite !== "none")) {
		return { ok: false, response: c.json({ error: "csrf_forbidden" }, 403) };
	}

	return authenticateAccessUser(c, fetchFn);
}

/** Verify Cloudflare Access for a read-only request without a CSRF check. */
export async function requireAccessUserForRead(
	c: Context<{ Bindings: Bindings }>,
	fetchFn: FetchFn = fetch,
): Promise<AccessAuthResult> {
	return authenticateAccessUser(c, fetchFn);
}
