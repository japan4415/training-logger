import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env.js";
import { registerExerciseProgressRoutes } from "../../src/views/exercise-progress.js";
import { registerExerciseListRoutes } from "../../src/views/exercises-list.js";
import { registerSessionViews } from "../../src/views/sessions-list.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const app = new Hono<{ Bindings: Bindings }>();
registerSessionViews(app);
registerExerciseListRoutes(app);
registerExerciseProgressRoutes(app);

/**
 * Two users share the exercise master. USER_A (id 1) is the implicit viewer of
 * every phase 2 entry point, so USER_B (id 2) rows must never appear.
 */
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
	]);
}

describe("view user isolation", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await seedIsolationData();
	});

	describe("GET / (session list)", () => {
		it("shows only the current user's sessions", async () => {
			const html = await (await app.request("/?month=2026-08", {}, env)).text();
			expect(html).toContain("USER-A-GOAL");
			expect(html).not.toContain("USER-B-SECRET");
			expect(html).not.toContain("2026/08/16");
		});
	});

	describe("GET /sessions/:id", () => {
		it("returns the current user's session", async () => {
			const response = await app.request("/sessions/1", {}, env);
			expect(response.status).toBe(200);
		});

		it("returns 404 for another user's session", async () => {
			const response = await app.request("/sessions/2", {}, env);
			expect(response.status).toBe(404);
			const html = await response.text();
			expect(html).not.toContain("USER-B-SECRET");
		});
	});

	describe("GET /exercises (exercise list)", () => {
		it("aggregates last performed and counts for the current user only", async () => {
			const html = await (await app.request("/exercises", {}, env)).text();
			expect(html).toContain("回数: 1");
			expect(html).toContain("2026-08-15");
			expect(html).not.toContain("2026-08-16");
		});
	});

	describe("GET /exercises/:id (progress)", () => {
		it("shows only the current user's history", async () => {
			const html = await (await app.request("/exercises/1", {}, env)).text();
			expect(html).toContain("60kg");
			expect(html).not.toContain("999kg");
			expect(html).not.toContain("2026-08-16");
		});
	});
});
