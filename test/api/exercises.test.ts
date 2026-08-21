import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../../src/api/routes.js";
import { registerExercise } from "../../src/db/exercises.js";
import { createSessionExercise, replaceSets } from "../../src/db/records.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import type { Bindings } from "../../src/env.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const app = new Hono<{ Bindings: Bindings }>();
registerApiRoutes(app);

/** Seed exercises with history for testing. */
async function seedTestData() {
	const { exercise: bench } = await registerExercise(env.DB, {
		name: "ベンチプレス",
		category: "strength",
		equipment: "バーベル",
		target_muscles: "胸,上腕三頭筋",
		aliases: ["Bench Press", "BP"],
	});
	const { exercise: walking } = await registerExercise(env.DB, {
		name: "ウォーキング",
		category: "cardio",
		equipment: "トレッドミル",
	});
	const { exercise: stretch } = await registerExercise(env.DB, {
		name: "ストレッチ",
		category: "flexibility",
	});

	// Session 2026-08-15: bench + walking
	const { session: s1 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-15",
		goal: "ダイエット",
	});
	const se1bench = await createSessionExercise(env.DB, {
		sessionId: s1.id,
		exerciseId: bench.id,
	});
	await replaceSets(env.DB, se1bench.id, [
		{ reps: 10, weightValue: 60, weightUnit: "kg" },
		{ reps: 8, weightValue: 65, weightUnit: "kg" },
	]);
	const se1walk = await createSessionExercise(env.DB, {
		sessionId: s1.id,
		exerciseId: walking.id,
	});
	await replaceSets(env.DB, se1walk.id, [
		{
			durationMinutes: 10,
			speedMin: 3.5,
			speedMax: 5.0,
		},
	]);

	// Session 2026-08-16: bench with planned + actual (higher weight)
	const { session: s2 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-16",
	});
	const se2bench = await createSessionExercise(env.DB, {
		sessionId: s2.id,
		exerciseId: bench.id,
	});
	await replaceSets(env.DB, se2bench.id, [
		{ isPlanned: true, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: false, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: false, reps: 8, weightValue: 70, weightUnit: "kg" },
		{ isPlanned: false, reps: 6, weightValue: 75, weightUnit: "kg" },
	]);

	// Session 2026-07-01: bench with lbs
	const { session: s3 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-07-01",
	});
	const se3bench = await createSessionExercise(env.DB, {
		sessionId: s3.id,
		exerciseId: bench.id,
	});
	await replaceSets(env.DB, se3bench.id, [
		{ reps: 12, weightValue: 100, weightUnit: "lbs" },
	]);

	return { bench, walking, stretch };
}

async function fetchJson(path: string) {
	const res = await app.request(path, {}, env);
	return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("Exercises API", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	describe("GET /api/exercises", () => {
		it("returns all exercises", async () => {
			await seedTestData();
			const { res, body } = await fetchJson("/api/exercises");

			expect(res.status).toBe(200);
			const exercises = body.exercises as Array<Record<string, unknown>>;
			expect(exercises).toHaveLength(3);
		});

		it("filters by category", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/exercises?category=strength");
			const exercises = body.exercises as Array<Record<string, unknown>>;

			expect(exercises).toHaveLength(1);
			expect(exercises[0].name).toBe("ベンチプレス");
			expect(exercises[0].category).toBe("strength");
		});

		it("filters by search query", async () => {
			await seedTestData();
			const { body } = await fetchJson(
				"/api/exercises?q=%E3%82%A6%E3%82%A9%E3%83%BC%E3%82%AD%E3%83%B3%E3%82%B0",
			);
			const exercises = body.exercises as Array<Record<string, unknown>>;

			expect(exercises).toHaveLength(1);
			expect(exercises[0].name).toBe("ウォーキング");
		});

		it("searches by alias", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/exercises?q=Bench%20Press");
			const exercises = body.exercises as Array<Record<string, unknown>>;

			expect(exercises).toHaveLength(1);
			expect(exercises[0].name).toBe("ベンチプレス");
		});

		it("includes last_performed and total_sessions", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/exercises?category=strength");
			const exercises = body.exercises as Array<Record<string, unknown>>;

			const bench = exercises[0];
			expect(bench.total_sessions).toBe(3);
			// last_performed = latest date with actual sets
			expect(bench.last_performed).toBe("2026-08-16");
		});

		it("returns null last_performed for unused exercise", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/exercises?category=flexibility");
			const exercises = body.exercises as Array<Record<string, unknown>>;

			const stretch = exercises[0];
			expect(stretch.name).toBe("ストレッチ");
			expect(stretch.last_performed).toBeNull();
			expect(stretch.total_sessions).toBe(0);
		});

		it("returns 400 for invalid category", async () => {
			const { res } = await fetchJson("/api/exercises?category=invalid");
			expect(res.status).toBe(400);
		});

		it("includes equipment and target_muscles", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/exercises?category=strength");
			const exercises = body.exercises as Array<Record<string, unknown>>;

			expect(exercises[0].equipment).toBe("バーベル");
			expect(exercises[0].target_muscles).toBe("胸,上腕三頭筋");
		});
	});

	describe("GET /api/exercises/:id", () => {
		it("returns exercise detail with aliases", async () => {
			const { bench } = await seedTestData();
			const { res, body } = await fetchJson(`/api/exercises/${bench.id}`);

			expect(res.status).toBe(200);
			const exercise = body.exercise as Record<string, unknown>;
			expect(exercise.id).toBe(bench.id);
			expect(exercise.name).toBe("ベンチプレス");
			expect(exercise.category).toBe("strength");
			expect(exercise.equipment).toBe("バーベル");
			expect(exercise.target_muscles).toBe("胸,上腕三頭筋");

			const aliases = exercise.aliases as string[];
			expect(aliases).toContain("Bench Press");
			expect(aliases).toContain("BP");
			expect(aliases).toHaveLength(2);
		});

		it("returns empty aliases for exercise without aliases", async () => {
			const { stretch } = await seedTestData();
			const { body } = await fetchJson(`/api/exercises/${stretch.id}`);
			const exercise = body.exercise as Record<string, unknown>;
			expect(exercise.aliases).toHaveLength(0);
		});

		it("returns 404 for non-existent exercise", async () => {
			const { res, body } = await fetchJson("/api/exercises/99999");
			expect(res.status).toBe(404);
			expect(body.error).toBeDefined();
		});

		it("returns 400 for invalid exercise ID", async () => {
			const { res } = await fetchJson("/api/exercises/abc");
			expect(res.status).toBe(400);
		});
	});

	describe("GET /api/exercises/:id/stats", () => {
		it("returns stats with max_weight_by_unit", async () => {
			const { bench } = await seedTestData();
			const { res, body } = await fetchJson(`/api/exercises/${bench.id}/stats`);

			expect(res.status).toBe(200);
			const stats = body.stats as Array<Record<string, unknown>>;
			// 3 sessions for bench: 2026-08-16, 2026-08-15, 2026-07-01
			expect(stats).toHaveLength(3);

			// Most recent first (DESC order)
			const latest = stats[0];
			expect(latest.date).toBe("2026-08-16");
			const maxByUnit = latest.max_weight_by_unit as Record<string, number>;
			expect(maxByUnit.kg).toBe(75);
		});

		it("computes max_weight_by_unit per session correctly", async () => {
			const { bench } = await seedTestData();
			const { body } = await fetchJson(`/api/exercises/${bench.id}/stats`);
			const stats = body.stats as Array<Record<string, unknown>>;

			// 2026-07-01 session uses lbs
			const oldSession = stats[2];
			expect(oldSession.date).toBe("2026-07-01");
			const maxByUnit = oldSession.max_weight_by_unit as Record<string, number>;
			expect(maxByUnit.lbs).toBe(100);
			expect(maxByUnit.kg).toBeUndefined();
		});

		it("includes total_reps and total_sets from actual sets only", async () => {
			const { bench } = await seedTestData();
			const { body } = await fetchJson(`/api/exercises/${bench.id}/stats`);
			const stats = body.stats as Array<Record<string, unknown>>;

			// 2026-08-16: 3 actual sets (10+8+6 = 24 reps)
			const s2 = stats[0];
			expect(s2.total_reps).toBe(24);
			expect(s2.total_sets).toBe(3);

			// 2026-08-15: 2 actual sets (10+8 = 18 reps)
			const s1 = stats[1];
			expect(s1.total_reps).toBe(18);
			expect(s1.total_sets).toBe(2);
		});

		it("includes individual sets in response", async () => {
			const { bench } = await seedTestData();
			const { body } = await fetchJson(`/api/exercises/${bench.id}/stats`);
			const stats = body.stats as Array<Record<string, unknown>>;

			const sets = stats[0].sets as Array<Record<string, unknown>>;
			expect(sets).toHaveLength(3);
			// All sets should be actual (is_planned === 0)
			for (const s of sets) {
				expect(s.is_planned).toBe(0);
			}
		});

		it("filters by from/to dates", async () => {
			const { bench } = await seedTestData();
			const { body } = await fetchJson(
				`/api/exercises/${bench.id}/stats?from=2026-08-01&to=2026-08-31`,
			);
			const stats = body.stats as Array<Record<string, unknown>>;

			// Only Aug sessions (2 out of 3)
			expect(stats).toHaveLength(2);
			expect(stats[0].date).toBe("2026-08-16");
			expect(stats[1].date).toBe("2026-08-15");
		});

		it("filters by period", async () => {
			const { bench } = await seedTestData();
			// "all" period should return everything
			const { body } = await fetchJson(
				`/api/exercises/${bench.id}/stats?period=all`,
			);
			const stats = body.stats as Array<Record<string, unknown>>;
			expect(stats).toHaveLength(3);
		});

		it("returns 400 for invalid period", async () => {
			const { bench } = await seedTestData();
			const { res } = await fetchJson(
				`/api/exercises/${bench.id}/stats?period=2y`,
			);
			expect(res.status).toBe(400);
		});

		it("returns 404 for non-existent exercise", async () => {
			const { res } = await fetchJson("/api/exercises/99999/stats");
			expect(res.status).toBe(404);
		});

		it("returns empty stats for exercise with no sessions", async () => {
			const { stretch } = await seedTestData();
			const { body } = await fetchJson(`/api/exercises/${stretch.id}/stats`);
			const stats = body.stats as Array<Record<string, unknown>>;
			expect(stats).toHaveLength(0);
		});

		it("handles cardio exercise stats (no weight data)", async () => {
			const { walking } = await seedTestData();
			const { res, body } = await fetchJson(
				`/api/exercises/${walking.id}/stats`,
			);

			expect(res.status).toBe(200);
			const stats = body.stats as Array<Record<string, unknown>>;
			expect(stats).toHaveLength(1);

			const s = stats[0];
			expect(s.date).toBe("2026-08-15");
			const maxByUnit = s.max_weight_by_unit as Record<string, number>;
			expect(Object.keys(maxByUnit)).toHaveLength(0);
			expect(s.total_sets).toBe(1);
		});
	});
});
