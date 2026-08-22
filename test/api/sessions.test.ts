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

/** Seed test data: two sessions in Aug 2026. */
async function seedTestData() {
	const { exercise: bench } = await registerExercise(env.DB, {
		name: "ベンチプレス",
		category: "strength",
		aliases: ["Bench Press"],
		target_muscles: "胸, 三頭筋",
	});
	const { exercise: walking } = await registerExercise(env.DB, {
		name: "ウォーキング",
		category: "cardio",
	});

	// Session 1: 2026-08-15 (土)
	const { session: s1 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-15",
		goal: "ダイエット",
		bodyCondition: "普通",
	});
	const se1bench = await createSessionExercise(env.DB, {
		sessionId: s1.id,
		exerciseId: bench.id,
		equipmentNote: "マシンA",
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
			inclinePercent: 0.5,
		},
	]);

	// Session 2: 2026-08-16 (日) — with planned + actual sets
	const { session: s2 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-16",
		goal: "上半身",
		bodyCondition: "良好",
		notes: "調子が良い",
	});
	const se2bench = await createSessionExercise(env.DB, {
		sessionId: s2.id,
		exerciseId: bench.id,
		formCues: "肘を締める",
	});
	await replaceSets(env.DB, se2bench.id, [
		{ isPlanned: true, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: true, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: false, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: false, reps: 8, weightValue: 70, weightUnit: "kg" },
		{ isPlanned: false, reps: 6, weightValue: 75, weightUnit: "kg" },
	]);

	return { benchId: bench.id, walkingId: walking.id, s1, s2 };
}

async function fetchJson(path: string) {
	const res = await app.request(path, {}, env);
	return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("Sessions API", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	describe("GET /api/sessions", () => {
		it("returns sessions for specified month", async () => {
			await seedTestData();
			const { res, body } = await fetchJson("/api/sessions?month=2026-08");

			expect(res.status).toBe(200);

			const sessions = body.sessions as Array<Record<string, unknown>>;
			expect(sessions).toHaveLength(2);
			expect(body.total).toBe(2);

			// Descending date order (getHistory returns DESC)
			expect(sessions[0].date).toBe("2026-08-16");
			expect(sessions[1].date).toBe("2026-08-15");
		});

		it("includes day_of_week derived from session_date", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/sessions?month=2026-08");
			const sessions = body.sessions as Array<Record<string, unknown>>;

			// 2026-08-16 is Sunday (日)
			expect(sessions[0].day_of_week).toBe("日");
			// 2026-08-15 is Saturday (土)
			expect(sessions[1].day_of_week).toBe("土");
		});

		it("includes exercise_count and exercise_names", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/sessions?month=2026-08");
			const sessions = body.sessions as Array<Record<string, unknown>>;

			// Session 2026-08-15 has 2 exercises
			const s1 = sessions[1];
			expect(s1.exercise_count).toBe(2);
			expect(s1.exercise_names).toContain("ベンチプレス");
			expect(s1.exercise_names).toContain("ウォーキング");

			// Session 2026-08-16 has 1 exercise
			const s2 = sessions[0];
			expect(s2.exercise_count).toBe(1);
			expect(s2.exercise_names).toContain("ベンチプレス");
		});

		it("includes goal and body_condition", async () => {
			await seedTestData();
			const { body } = await fetchJson("/api/sessions?month=2026-08");
			const sessions = body.sessions as Array<Record<string, unknown>>;

			expect(sessions[1].goal).toBe("ダイエット");
			expect(sessions[1].body_condition).toBe("普通");
			expect(sessions[0].goal).toBe("上半身");
			expect(sessions[0].body_condition).toBe("良好");
		});

		it("returns empty list for month with no sessions", async () => {
			await seedTestData();
			const { res, body } = await fetchJson("/api/sessions?month=2026-01");

			expect(res.status).toBe(200);
			expect(body.sessions).toHaveLength(0);
			expect(body.total).toBe(0);
		});

		it("paginates with limit and offset", async () => {
			await seedTestData();

			// First page
			const { body: page1 } = await fetchJson(
				"/api/sessions?month=2026-08&limit=1&offset=0",
			);
			const s1 = page1.sessions as Array<Record<string, unknown>>;
			expect(s1).toHaveLength(1);
			expect(s1[0].date).toBe("2026-08-16");
			expect(page1.total).toBe(2);

			// Second page
			const { body: page2 } = await fetchJson(
				"/api/sessions?month=2026-08&limit=1&offset=1",
			);
			const s2 = page2.sessions as Array<Record<string, unknown>>;
			expect(s2).toHaveLength(1);
			expect(s2[0].date).toBe("2026-08-15");
			expect(page2.total).toBe(2);
		});

		it("returns 400 for invalid month format", async () => {
			const { res, body } = await fetchJson("/api/sessions?month=2026-13");
			expect(res.status).toBe(400);
			expect(body.error).toBeDefined();
		});

		it("returns 400 for malformed month string", async () => {
			const { res } = await fetchJson("/api/sessions?month=invalid");
			expect(res.status).toBe(400);
		});
	});

	describe("GET /api/sessions/:id", () => {
		it("returns session detail with exercises", async () => {
			const { s1 } = await seedTestData();
			const { res, body } = await fetchJson(`/api/sessions/${s1.id}`);

			expect(res.status).toBe(200);

			const session = body.session as Record<string, unknown>;
			expect(session.id).toBe(s1.id);
			expect(session.date).toBe("2026-08-15");
			expect(session.day_of_week).toBe("土");
			expect(session.goal).toBe("ダイエット");
			expect(session.body_condition).toBe("普通");

			const exercises = session.exercises as Array<Record<string, unknown>>;
			expect(exercises).toHaveLength(2);
		});

		it("separates actual sets and planned sets", async () => {
			const { s2 } = await seedTestData();
			const { body } = await fetchJson(`/api/sessions/${s2.id}`);

			const session = body.session as Record<string, unknown>;
			const exercises = session.exercises as Array<Record<string, unknown>>;
			const bench = exercises.find((e) => e.name === "ベンチプレス") as Record<
				string,
				unknown
			>;

			expect(bench).toBeDefined();
			const sets = bench.sets as Array<Record<string, unknown>>;
			const plannedSets = bench.planned_sets as Array<Record<string, unknown>>;

			// 3 actual sets, 2 planned sets
			expect(sets).toHaveLength(3);
			expect(plannedSets).toHaveLength(2);

			// Actual sets should have is_planned === 0
			for (const s of sets) {
				expect(s.is_planned).toBe(0);
			}
			// Planned sets should have is_planned === 1
			for (const s of plannedSets) {
				expect(s.is_planned).toBe(1);
			}
		});

		it("includes exercise metadata", async () => {
			const { s1 } = await seedTestData();
			const { body } = await fetchJson(`/api/sessions/${s1.id}`);

			const session = body.session as Record<string, unknown>;
			const exercises = session.exercises as Array<Record<string, unknown>>;
			const bench = exercises.find((e) => e.name === "ベンチプレス") as Record<
				string,
				unknown
			>;

			expect(bench.exercise_id).toBeGreaterThan(0);
			expect(bench.status).toBe("completed");
			expect(bench.equipment_note).toBe("マシンA");
		});

		it("includes form_cues and notes", async () => {
			const { s2 } = await seedTestData();
			const { body } = await fetchJson(`/api/sessions/${s2.id}`);

			const session = body.session as Record<string, unknown>;
			expect(session.notes).toBe("調子が良い");

			const exercises = session.exercises as Array<Record<string, unknown>>;
			const bench = exercises.find((e) => e.name === "ベンチプレス") as Record<
				string,
				unknown
			>;
			expect(bench.form_cues).toBe("肘を締める");
		});

		it("returns 404 for non-existent session", async () => {
			const { res, body } = await fetchJson("/api/sessions/99999");
			expect(res.status).toBe(404);
			expect(body.error).toBeDefined();
		});

		it("returns 400 for invalid session ID", async () => {
			const { res } = await fetchJson("/api/sessions/abc");
			expect(res.status).toBe(400);
		});

		it("returns 400 for non-integer session ID", async () => {
			const { res } = await fetchJson("/api/sessions/1.5");
			expect(res.status).toBe(400);
		});

		it("includes target_muscles_summary with deduplicated muscles", async () => {
			const { s1 } = await seedTestData();
			const { body } = await fetchJson(`/api/sessions/${s1.id}`);

			const session = body.session as Record<string, unknown>;
			const summary = session.target_muscles_summary as string[];
			// Session 1 has ベンチプレス (target_muscles: "胸, 三頭筋") and ウォーキング (null)
			expect(summary).toContain("胸");
			expect(summary).toContain("三頭筋");
			expect(summary).toHaveLength(2);
		});

		it("includes target_muscles per exercise", async () => {
			const { s1 } = await seedTestData();
			const { body } = await fetchJson(`/api/sessions/${s1.id}`);

			const session = body.session as Record<string, unknown>;
			const exercises = session.exercises as Array<Record<string, unknown>>;
			const bench = exercises.find((e) => e.name === "ベンチプレス") as Record<
				string,
				unknown
			>;
			const walk = exercises.find((e) => e.name === "ウォーキング") as Record<
				string,
				unknown
			>;

			expect(bench.target_muscles).toBe("胸, 三頭筋");
			expect(walk.target_muscles).toBeNull();
		});

		it("returns empty target_muscles_summary when no exercises have target_muscles", async () => {
			// Create a session with only exercises that have null target_muscles
			const { exercise: stretch } = await registerExercise(env.DB, {
				name: "ストレッチ",
				category: "flexibility",
			});
			const { session: s3 } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-09-01",
			});
			await createSessionExercise(env.DB, {
				sessionId: s3.id,
				exerciseId: stretch.id,
			});

			const { body } = await fetchJson(`/api/sessions/${s3.id}`);
			const session = body.session as Record<string, unknown>;
			const summary = session.target_muscles_summary as string[];
			expect(summary).toHaveLength(0);
		});
	});
});
