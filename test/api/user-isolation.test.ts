import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../../src/api/routes.js";
import type { Bindings } from "../../src/env.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const app = new Hono<{ Bindings: Bindings }>();
registerApiRoutes(app);

async function seedIsolationData(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (2, NULL, 'active', 'member')",
		),
		env.DB.prepare(
			"INSERT INTO exercises (id, name, category, equipment) VALUES (1, 'ベンチプレス', 'strength', 'バーベル')",
		),
		env.DB.prepare(
			"INSERT INTO workout_sessions (id, user_id, session_date, goal) VALUES (1, 1, '2026-08-15', 'USER-A-GOAL')",
		),
		env.DB.prepare(
			"INSERT INTO workout_sessions (id, user_id, session_date, goal) VALUES (2, 2, '2026-08-16', 'USER-B-SECRET')",
		),
		env.DB.prepare(
			"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (1, 1, 1, 1, 'completed')",
		),
		env.DB.prepare(
			"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (2, 2, 1, 1, 'completed')",
		),
		env.DB.prepare(
			"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit) VALUES (1, 1, 0, 10, 60, 'kg')",
		),
		env.DB.prepare(
			"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit) VALUES (2, 1, 0, 10, 999, 'kg')",
		),
		env.DB.prepare(
			"INSERT INTO session_photos (id, session_id, r2_key, content_type, size_bytes) VALUES ('b-photo', 2, 'sessions/2026-08-16/2/b.jpg', 'image/jpeg', 100)",
		),
	]);
}

async function fetchJson(path: string) {
	const res = await app.request(path, {}, env);
	return { res, body: (await res.json()) as Record<string, unknown> };
}

const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };
const allowEnv = () => ({
	...env,
	PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
});

function photoForm() {
	const form = new FormData();
	form.set(
		"photo",
		new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "photo.jpg", {
			type: "image/jpeg",
		}),
	);
	return form;
}

describe("API user isolation", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await seedIsolationData();
	});

	it("lists only the current user's sessions", async () => {
		const { res, body } = await fetchJson("/api/sessions?month=2026-08");
		expect(res.status).toBe(200);
		const sessions = body.sessions as Array<Record<string, unknown>>;
		expect(sessions).toHaveLength(1);
		expect(sessions[0].goal).toBe("USER-A-GOAL");
		expect(body.total).toBe(1);
	});

	it("returns 404 for another user's session", async () => {
		const { res } = await fetchJson("/api/sessions/2");
		expect(res.status).toBe(404);
	});

	it("counts exercise aggregates for the current user only", async () => {
		const { body } = await fetchJson("/api/exercises?category=strength");
		const exercises = body.exercises as Array<Record<string, unknown>>;
		expect(exercises).toHaveLength(1);
		expect(exercises[0].last_performed).toBe("2026-08-15");
		expect(exercises[0].total_sessions).toBe(1);
	});

	it("computes exercise stats from the current user's sets only", async () => {
		const { body } = await fetchJson("/api/exercises/1/stats");
		const stats = body.stats as Array<Record<string, unknown>>;
		expect(stats).toHaveLength(1);
		expect(stats[0].date).toBe("2026-08-15");
		const maxByUnit = stats[0].max_weight_by_unit as Record<string, number>;
		expect(maxByUnit.kg).toBe(60);
	});

	it("returns 404 when reading another user's photos", async () => {
		expect(
			(await app.request("/api/sessions/2/photos", {}, allowEnv())).status,
		).toBe(404);
		expect(
			(await app.request("/api/sessions/2/photos/b-photo", {}, allowEnv()))
				.status,
		).toBe(404);
	});

	it("returns 404 when mutating another user's photos and keeps them", async () => {
		const posted = await app.request(
			"/api/sessions/2/photos",
			{
				method: "POST",
				headers: { ...SAME_ORIGIN, "Content-Length": "1024" },
				body: photoForm(),
			},
			allowEnv(),
		);
		expect(posted.status).toBe(404);

		const deleted = await app.request(
			"/api/sessions/2/photos/b-photo",
			{ method: "DELETE", headers: SAME_ORIGIN },
			allowEnv(),
		);
		expect(deleted.status).toBe(404);

		expect(
			await env.DB.prepare("SELECT id FROM session_photos WHERE id = ?")
				.bind("b-photo")
				.first(),
		).not.toBeNull();
	});
});
