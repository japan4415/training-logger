import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExercise } from "../../../src/db/exercises.js";
import { createSessionExercise, replaceSets } from "../../../src/db/records.js";
import { getOrCreateSession } from "../../../src/db/sessions.js";
import { getHistoryHandler } from "../../../src/mcp/tools/history.js";
import { applyMigrations, cleanDatabase } from "../../db/test-helpers.js";

/**
 * Seed test data: two sessions with various exercises and sets.
 *
 * Session 2026-08-15 (goal: "ダイエット"):
 *   - ベンチプレス: 2 actual sets (10rep/60kg, 8rep/65kg)
 *   - ウォーキング: 1 actual set (cardio: 10min, 3.5-5.0 km/h)
 *
 * Session 2026-08-16:
 *   - ベンチプレス: 3 actual sets (10rep/60kg, 8rep/70kg, 6rep/75kg) + 2 planned (10rep/60kg x2)
 *   - ストレッチボード: 1 actual set (flexibility: 20 degrees)
 */
async function seedTestData(): Promise<void> {
	const { exercise: bench } = await registerExercise(env.DB, {
		name: "ベンチプレス",
		category: "strength",
		aliases: ["Bench Press"],
	});
	const { exercise: walking } = await registerExercise(env.DB, {
		name: "ウォーキング",
		category: "cardio",
	});
	const { exercise: stretch } = await registerExercise(env.DB, {
		name: "ストレッチボード",
		category: "flexibility",
	});

	// Session 1: 2026-08-15
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
			inclinePercent: 0.5,
		},
	]);

	// Session 2: 2026-08-16
	const { session: s2 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-16",
	});
	const se2bench = await createSessionExercise(env.DB, {
		sessionId: s2.id,
		exerciseId: bench.id,
	});
	await replaceSets(env.DB, se2bench.id, [
		{ isPlanned: true, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: true, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: false, reps: 10, weightValue: 60, weightUnit: "kg" },
		{ isPlanned: false, reps: 8, weightValue: 70, weightUnit: "kg" },
		{ isPlanned: false, reps: 6, weightValue: 75, weightUnit: "kg" },
	]);
	const se2stretch = await createSessionExercise(env.DB, {
		sessionId: s2.id,
		exerciseId: stretch.id,
	});
	await replaceSets(env.DB, se2stretch.id, [{ angleDegrees: 20 }]);
}

describe("getHistoryHandler", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await seedTestData();
	});

	it("should return latest 5 sessions by default when no params", async () => {
		const result = await getHistoryHandler(env, {});
		// We only have 2 sessions, so both should be returned
		expect(result.sessions).toHaveLength(2);
		// Descending date order
		expect(result.sessions[0].date).toBe("2026-08-16");
		expect(result.sessions[1].date).toBe("2026-08-15");
	});

	it("should include session metadata", async () => {
		const result = await getHistoryHandler(env, {});
		const session = result.sessions.find((s) => s.date === "2026-08-15");
		expect(session).toBeDefined();
		expect(session?.goal).toBe("ダイエット");
	});

	it("should include exercises with sets by default", async () => {
		const result = await getHistoryHandler(env, {});
		const session = result.sessions[0]; // 2026-08-16
		expect(session.exercises.length).toBeGreaterThan(0);

		const bench = session.exercises.find((e) => e.name === "ベンチプレス");
		expect(bench).toBeDefined();
		expect(bench?.sets.length).toBeGreaterThan(0);
	});

	it("should format sets correctly", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "ベンチプレス",
			lastNSessions: 1,
		});
		expect(result.sessions).toHaveLength(1);

		const bench = result.sessions[0].exercises[0];
		expect(bench.name).toBe("ベンチプレス");

		// Check that is_planned is a boolean (not 0/1)
		const plannedSets = bench.sets.filter((s) => s.is_planned);
		const actualSets = bench.sets.filter((s) => !s.is_planned);
		expect(plannedSets).toHaveLength(2);
		expect(actualSets).toHaveLength(3);

		// Check weight formatting
		const firstActual = actualSets[0];
		expect(firstActual.weight).toBe(60);
		expect(firstActual.weight_unit).toBe("kg");
		expect(firstActual.reps).toBe(10);
	});

	it("should filter by exercise_name (exact match)", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "ウォーキング",
		});
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].date).toBe("2026-08-15");
		expect(result.sessions[0].exercises).toHaveLength(1);
		expect(result.sessions[0].exercises[0].name).toBe("ウォーキング");
	});

	it("should filter by exercise_name via alias", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "Bench Press",
		});
		// ベンチプレス appears in both sessions
		expect(result.sessions).toHaveLength(2);
		for (const session of result.sessions) {
			expect(session.exercises).toHaveLength(1);
			expect(session.exercises[0].name).toBe("ベンチプレス");
		}
	});

	it("should return empty sessions for non-existent exercise", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "存在しない種目",
		});
		expect(result.sessions).toHaveLength(0);
	});

	it("should filter by date range (dateFrom only)", async () => {
		const result = await getHistoryHandler(env, {
			dateFrom: "2026-08-16",
		});
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].date).toBe("2026-08-16");
	});

	it("should filter by date range (dateTo only)", async () => {
		const result = await getHistoryHandler(env, {
			dateTo: "2026-08-15",
		});
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].date).toBe("2026-08-15");
	});

	it("should filter by date range (both dateFrom and dateTo)", async () => {
		const result = await getHistoryHandler(env, {
			dateFrom: "2026-08-15",
			dateTo: "2026-08-15",
		});
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].date).toBe("2026-08-15");
	});

	it("should limit by lastNSessions", async () => {
		const result = await getHistoryHandler(env, {
			lastNSessions: 1,
		});
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].date).toBe("2026-08-16");
	});

	it("should exclude sets when includeSets is false", async () => {
		const result = await getHistoryHandler(env, {
			includeSets: false,
		});
		expect(result.sessions).toHaveLength(2);
		for (const session of result.sessions) {
			for (const exercise of session.exercises) {
				expect(exercise.sets).toHaveLength(0);
			}
		}
	});

	it("should combine exercise_name and date_from filters", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "ベンチプレス",
			dateFrom: "2026-08-16",
		});
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].date).toBe("2026-08-16");
		expect(result.sessions[0].exercises[0].name).toBe("ベンチプレス");
	});

	it("should handle cardio exercise sets correctly", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "ウォーキング",
		});
		expect(result.sessions).toHaveLength(1);
		const walkSet = result.sessions[0].exercises[0].sets[0];
		expect(walkSet.duration_minutes).toBe(10);
		expect(walkSet.speed_min).toBe(3.5);
		expect(walkSet.speed_max).toBe(5.0);
		expect(walkSet.incline_percent).toBe(0.5);
		// weight fields should be null for cardio
		expect(walkSet.weight).toBeNull();
		expect(walkSet.weight_unit).toBeNull();
		expect(walkSet.reps).toBeNull();
	});

	it("should handle flexibility exercise sets correctly", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "ストレッチボード",
		});
		expect(result.sessions).toHaveLength(1);
		const stretchSet = result.sessions[0].exercises[0].sets[0];
		expect(stretchSet.angle_degrees).toBe(20);
		expect(stretchSet.weight).toBeNull();
		expect(stretchSet.reps).toBeNull();
	});

	it("should include exercise metadata (category, status, etc.)", async () => {
		const result = await getHistoryHandler(env, {
			exerciseName: "ベンチプレス",
			lastNSessions: 1,
		});
		const exercise = result.sessions[0].exercises[0];
		expect(exercise.category).toBe("strength");
		expect(exercise.status).toBe("completed");
	});
});
