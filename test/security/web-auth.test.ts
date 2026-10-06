import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../../src/api/routes.js";
import { ACCESS_IDENTITY_PROVIDER } from "../../src/db/users.js";
import type { AppEnv, Bindings } from "../../src/env.js";
import { registerAccessAuth } from "../../src/security/auth.js";
import { registerExerciseProgressRoutes } from "../../src/views/exercise-progress.js";
import { registerExerciseListRoutes } from "../../src/views/exercises-list.js";
import { registerSessionViews } from "../../src/views/sessions-list.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const DOMAIN = "team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
let keys: CryptoKeyPair;
let publicJwk: JsonWebKey;

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

async function jwt(payload: Record<string, unknown>): Promise<string> {
	const header = base64Url(
		new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "key-1" })),
	);
	const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		keys.privateKey,
		new TextEncoder().encode(`${header}.${body}`),
	);
	return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/** Valid token for the given subject/email and a future expiry. */
async function validJwt(sub: string, email?: string): Promise<string> {
	return jwt({
		sub,
		email,
		aud: AUDIENCE,
		exp: Math.floor(Date.now() / 1000) + 60,
	});
}

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

/** Minimal app: only proves whether the middleware let the request through. */
function echoApp(fetchFn: typeof fetch) {
	const app = new Hono<AppEnv>();
	registerAccessAuth(app, fetchFn);
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/", (c) => c.html("home"));
	app.get("/api/sessions", (c) => c.json({ userId: c.get("userId") }));
	app.post("/api/sessions", (c) => c.json({ userId: c.get("userId") }));
	app.get("/mcp", (c) => c.text("mcp"));
	app.get("/skills/log-workout/SKILL.md", (c) => c.text("skill"));
	app.get("/css/style.css", (c) => c.text("css"));
	app.get("/js/chart-init.js", (c) => c.text("js"));
	app.get("/models/human-atlas/atlas.json", (c) => c.text("model"));
	app.get("/favicon.ico", (c) => c.text("icon"));
	return app;
}

/** Real Web / REST routes behind the middleware, for auth-chain isolation. */
function fullApp(fetchFn: typeof fetch) {
	const app = new Hono<AppEnv>();
	registerAccessAuth(app, fetchFn);
	registerApiRoutes(app);
	registerExerciseListRoutes(app);
	registerExerciseProgressRoutes(app);
	registerSessionViews(app);
	return app;
}

function accessBindings(overrides: Partial<Bindings> = {}): Bindings {
	return {
		DB: env.DB,
		PHOTOS: env.PHOTOS,
		ACCESS_TEAM_DOMAIN: DOMAIN,
		ACCESS_AUD: AUDIENCE,
		...overrides,
	};
}

async function seedUser(
	id: number,
	status: "active" | "disabled" = "active",
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO users (id, display_name, status, role) VALUES (?, NULL, ?, 'member')",
	)
		.bind(id, status)
		.run();
}

async function seedIdentity(params: {
	userId: number;
	subject?: string | null;
	email?: string | null;
}): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO user_identities (user_id, provider, subject, email)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(
			params.userId,
			ACCESS_IDENTITY_PROVIDER,
			params.subject ?? null,
			params.email ?? null,
		)
		.run();
}

describe("Web / REST Access middleware", () => {
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
	});

	describe("deny-by-default", () => {
		it("rejects an unauthenticated protected GET with 401", async () => {
			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{},
				accessBindings(),
			);
			expect(response.status).toBe(401);
		});

		it("rejects HEAD and OPTIONS on a protected path without a JWT", async () => {
			const app = echoApp(jwksFetch());
			for (const method of ["HEAD", "OPTIONS"]) {
				const response = await app.request(
					"/api/sessions",
					{ method },
					accessBindings(),
				);
				expect(response.status).toBe(401);
			}
		});

		it("rejects protected paths regardless of trailing slash, case or double slashes", async () => {
			const app = echoApp(jwksFetch());
			for (const path of [
				"/api/sessions/",
				"//api/sessions",
				"/API/sessions",
				"/health",
			]) {
				const response = await app.request(path, {}, accessBindings());
				expect(response.status).toBe(401);
			}
		});

		it("fails closed with access_not_configured when Access env is unset", async () => {
			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{},
				{
					DB: env.DB,
					PHOTOS: env.PHOTOS,
					PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: undefined,
				},
			);
			expect(response.status).toBe(401);
			expect((await response.json()).error).toBe("access_not_configured");
		});

		it("requires a CSRF-safe Fetch Metadata for mutating requests", async () => {
			const token = await validJwt("subject-1");
			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{
					method: "POST",
					headers: { "Cf-Access-Jwt-Assertion": token },
				},
				accessBindings(),
			);
			expect(response.status).toBe(403);
			expect((await response.json()).error).toBe("csrf_forbidden");
		});
	});

	describe("public paths", () => {
		it("lets /mcp, /skills, static assets and /favicon.ico through without a JWT", async () => {
			const app = echoApp(jwksFetch());
			for (const path of [
				"/mcp",
				"/skills/log-workout/SKILL.md",
				"/css/style.css",
				"/js/chart-init.js",
				"/models/human-atlas/atlas.json",
				"/favicon.ico",
			]) {
				const response = await app.request(path, {}, accessBindings());
				expect(response.status).toBe(200);
			}
		});

		it("normalizes public paths without turning protected ones public", async () => {
			const app = echoApp(jwksFetch());
			for (const path of ["//mcp", "/MCP", "/mcp/"]) {
				const response = await app.request(path, {}, accessBindings());
				expect(response.status).not.toBe(401);
			}
			for (const path of ["//skills", "/SKILLS/log-workout/SKILL.md"]) {
				const response = await app.request(path, {}, accessBindings());
				expect(response.status).not.toBe(401);
			}
		});

		it("does not fetch JWKS for public paths", async () => {
			const fetchFn = jwksFetch();
			await echoApp(fetchFn).request("/mcp", {}, accessBindings());
			expect(fetchFn).not.toHaveBeenCalled();
		});
	});

	describe("subject to users.id resolution", () => {
		it("propagates the resolved internal user id to the handler", async () => {
			await seedUser(7);
			await seedIdentity({ userId: 7, subject: "subject-7" });

			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{ headers: { "Cf-Access-Jwt-Assertion": await validJwt("subject-7") } },
				accessBindings(),
			);
			expect(response.status).toBe(200);
			expect((await response.json()).userId).toBe(7);
		});

		it("returns 403 for an unregistered subject without creating a user", async () => {
			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{
					headers: {
						"Cf-Access-Jwt-Assertion": await validJwt(
							"unknown",
							"someone@example.com",
						),
					},
				},
				accessBindings(),
			);
			expect(response.status).toBe(403);
			expect((await response.json()).error).toBe("user_not_registered");
			const count = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM users",
			).first<{ n: number }>();
			expect(count?.n).toBe(1); // default owner only
		});

		it("returns 403 for a disabled user", async () => {
			await seedUser(8, "disabled");
			await seedIdentity({ userId: 8, subject: "subject-8" });

			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{ headers: { "Cf-Access-Jwt-Assertion": await validJwt("subject-8") } },
				accessBindings(),
			);
			expect(response.status).toBe(403);
			expect((await response.json()).error).toBe("account_disabled");
		});

		it("binds an invite row by verified email on first login only", async () => {
			await seedUser(9);
			await seedIdentity({ userId: 9, email: "invitee@example.com" });
			const app = echoApp(jwksFetch());

			const first = await app.request(
				"/api/sessions",
				{
					headers: {
						"Cf-Access-Jwt-Assertion": await validJwt(
							"subject-9",
							"invitee@example.com",
						),
					},
				},
				accessBindings(),
			);
			expect(first.status).toBe(200);
			expect((await first.json()).userId).toBe(9);

			const second = await app.request(
				"/api/sessions",
				{
					headers: {
						"Cf-Access-Jwt-Assertion": await validJwt(
							"subject-other",
							"invitee@example.com",
						),
					},
				},
				accessBindings(),
			);
			expect(second.status).toBe(403);
		});

		it("rejects a token without a subject", async () => {
			const token = await jwt({
				aud: AUDIENCE,
				exp: Math.floor(Date.now() / 1000) + 60,
			});
			const response = await echoApp(jwksFetch()).request(
				"/api/sessions",
				{ headers: { "Cf-Access-Jwt-Assertion": token } },
				accessBindings(),
			);
			expect(response.status).toBe(401);
		});
	});

	describe("local development fallback", () => {
		it("uses the default user for localhost when the dev flag is set", async () => {
			const response = await echoApp(jwksFetch()).request(
				"http://localhost/api/sessions",
				{},
				{
					DB: env.DB,
					PHOTOS: env.PHOTOS,
					PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
				},
			);
			expect(response.status).toBe(200);
			expect((await response.json()).userId).toBe(1);
		});

		it("ignores the dev flag on a non-local host and fails closed", async () => {
			const response = await echoApp(jwksFetch()).request(
				"https://training-logger.discord.jp/api/sessions",
				{},
				{
					DB: env.DB,
					PHOTOS: env.PHOTOS,
					PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
				},
			);
			expect(response.status).toBe(401);
			expect((await response.json()).error).toBe("access_not_configured");
		});
	});

	describe("cross-user isolation through the auth chain", () => {
		async function seedIsolationData(): Promise<void> {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO users (id, display_name, status, role) VALUES (2, NULL, 'active', 'member')",
				),
				env.DB.prepare(
					"INSERT INTO user_identities (user_id, provider, subject) VALUES (2, ?, ?)",
				).bind(ACCESS_IDENTITY_PROVIDER, "subject-user-2"),
				env.DB.prepare(
					"INSERT INTO exercises (id, name, category, equipment) VALUES (1, 'ベンチプレス', 'strength', 'バーベル')",
				),
				env.DB.prepare(
					"INSERT INTO workout_sessions (id, user_id, session_date, goal) VALUES (1, 1, '2026-08-15', 'USER-A-SECRET')",
				),
				env.DB.prepare(
					"INSERT INTO workout_sessions (id, user_id, session_date, goal) VALUES (2, 2, '2026-08-16', 'USER-B-GOAL')",
				),
				env.DB.prepare(
					"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (1, 1, 1, 1, 'completed')",
				),
				env.DB.prepare(
					"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (2, 2, 1, 1, 'completed')",
				),
				env.DB.prepare(
					"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit) VALUES (1, 1, 0, 10, 999, 'kg')",
				),
				env.DB.prepare(
					"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit) VALUES (2, 1, 0, 10, 50, 'kg')",
				),
				env.DB.prepare(
					"INSERT INTO session_photos (id, session_id, r2_key, content_type, size_bytes) VALUES ('a-photo', 1, 'sessions/2026-08-15/1/a.jpg', 'image/jpeg', 100)",
				),
			]);
		}

		async function requestAsUser2(path: string, init: RequestInit = {}) {
			const token = await validJwt("subject-user-2");
			return fullApp(jwksFetch()).request(
				path,
				{
					...init,
					headers: { ...init.headers, "Cf-Access-Jwt-Assertion": token },
				},
				accessBindings(),
			);
		}

		beforeEach(async () => {
			await seedIsolationData();
		});

		it("shows only the authenticated user's sessions in SSR and REST", async () => {
			const api = await requestAsUser2("/api/sessions?month=2026-08");
			expect(api.status).toBe(200);
			const body = (await api.json()) as { sessions: { goal: string }[] };
			expect(body.sessions).toHaveLength(1);
			expect(body.sessions[0].goal).toBe("USER-B-GOAL");

			const html = await (await requestAsUser2("/?month=2026-08")).text();
			expect(html).toContain("USER-B-GOAL");
			expect(html).not.toContain("USER-A-SECRET");
		});

		it("returns 404 for another user's session, photos and REST detail", async () => {
			expect((await requestAsUser2("/api/sessions/1")).status).toBe(404);
			expect((await requestAsUser2("/sessions/1")).status).toBe(404);
			expect((await requestAsUser2("/sessions/1/photos")).status).toBe(404);
			expect((await requestAsUser2("/api/sessions/1/photos")).status).toBe(404);
		});

		it("excludes another user's exercise aggregates from views and stats", async () => {
			const html = await (await requestAsUser2("/exercises")).text();
			expect(html).toContain("回数: 1");
			expect(html).not.toContain("2026-08-15");

			const progress = await (await requestAsUser2("/exercises/1")).text();
			expect(progress).toContain("50kg");
			expect(progress).not.toContain("999kg");

			const stats = await requestAsUser2("/api/exercises/1/stats");
			expect(stats.status).toBe(200);
			const body = (await stats.json()) as {
				stats: Array<{
					date: string;
					max_weight_by_unit: Record<string, number>;
				}>;
			};
			expect(body.stats).toHaveLength(1);
			expect(body.stats[0].date).toBe("2026-08-16");
			expect(body.stats[0].max_weight_by_unit.kg).toBe(50);
		});
	});
});
