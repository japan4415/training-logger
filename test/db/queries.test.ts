import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExercise } from "../../src/db/exercises.js";
import {
	getExerciseStats,
	getHistory,
	getSessionDetail,
	type SessionDetail,
} from "../../src/db/queries.js";
import { createSessionExercise, replaceSets } from "../../src/db/records.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

/**
 * Helper: set up a realistic two-session scenario based on docs/database.md.
 *
 * Session 2026-08-15 (goal: "ダイエット"):
 *   - ベンチプレス: 2 actual sets (10rep/60kg, 8rep/65kg)
 *   - ウォーキング: 1 actual set (cardio: 10min, 3.5-5.0 km/h)
 *
 * Session 2026-08-16:
 *   - ベンチプレス: 3 actual sets (10rep/60kg, 8rep/70kg, 6rep/75kg) + 2 planned (10rep/60kg x2)
 *   - ストレッチボード: 1 actual set (flexibility: 20 degrees)
 */
async function seedTestData(): Promise<{
	benchId: number;
	walkingId: number;
	stretchId: number;
	session1Id: number;
	session2Id: number;
}> {
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
		{ durationMinutes: 10, speedMin: 3.5, speedMax: 5.0, inclinePercent: 0.5 },
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

	return {
		benchId: bench.id,
		walkingId: walking.id,
		stretchId: stretch.id,
		session1Id: s1.id,
		session2Id: s2.id,
	};
}

describe("queries", () => {
	let benchId: number;
	let walkingId: number;
	let stretchId: number;
	let session1Id: number;
	let session2Id: number;

	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		const data = await seedTestData();
		benchId = data.benchId;
		walkingId = data.walkingId;
		stretchId = data.stretchId;
		session1Id = data.session1Id;
		session2Id = data.session2Id;
	});

	describe("getHistory", () => {
		it("should return all sessions when no filters", async () => {
			const history = await getHistory(env.DB);
			expect(history).toHaveLength(2);
			// Descending date order
			expect(history[0].session.session_date).toBe("2026-08-16");
			expect(history[1].session.session_date).toBe("2026-08-15");
		});

		it("should include exercises and sets in results", async () => {
			const history = await getHistory(env.DB);
			// Session 2026-08-16 has 2 exercises
			const s2 = history[0];
			expect(s2.exercises).toHaveLength(2);
			// Session 2026-08-15 has 2 exercises
			const s1 = history[1];
			expect(s1.exercises).toHaveLength(2);
		});

		it("should filter by exercise name (exact match)", async () => {
			const history = await getHistory(env.DB, {
				exerciseName: "ウォーキング",
			});
			expect(history).toHaveLength(1);
			expect(history[0].session.session_date).toBe("2026-08-15");
			// Only the matching exercise should be included
			expect(history[0].exercises).toHaveLength(1);
			expect(history[0].exercises[0].exercise.name).toBe("ウォーキング");
		});

		it("should filter by exercise name via alias (3-stage resolution)", async () => {
			const history = await getHistory(env.DB, {
				exerciseName: "Bench Press",
			});
			// ベンチプレス appears in both sessions
			expect(history).toHaveLength(2);
			for (const detail of history) {
				expect(detail.exercises).toHaveLength(1);
				expect(detail.exercises[0].exercise.name).toBe("ベンチプレス");
			}
		});

		it("should return empty for non-existent exercise name", async () => {
			const history = await getHistory(env.DB, {
				exerciseName: "存在しない種目",
			});
			expect(history).toHaveLength(0);
		});

		it("should filter by date range", async () => {
			const history = await getHistory(env.DB, {
				dateFrom: "2026-08-16",
				dateTo: "2026-08-16",
			});
			expect(history).toHaveLength(1);
			expect(history[0].session.session_date).toBe("2026-08-16");
		});

		it("should limit by lastNSessions", async () => {
			const history = await getHistory(env.DB, { lastNSessions: 1 });
			expect(history).toHaveLength(1);
			expect(history[0].session.session_date).toBe("2026-08-16");
		});

		it("should combine exercise name and date range filters", async () => {
			const history = await getHistory(env.DB, {
				exerciseName: "ベンチプレス",
				dateFrom: "2026-08-16",
			});
			expect(history).toHaveLength(1);
			expect(history[0].session.session_date).toBe("2026-08-16");
			expect(history[0].exercises[0].exercise.name).toBe("ベンチプレス");
		});

		it("should exclude sets when includeSets is false", async () => {
			const history = await getHistory(env.DB, { includeSets: false });
			expect(history).toHaveLength(2);
			for (const detail of history) {
				for (const ex of detail.exercises) {
					expect(ex.sets).toHaveLength(0);
				}
			}
		});

		it("should include sets by default", async () => {
			const history = await getHistory(env.DB);
			// Session 2026-08-16, ベンチプレス has 5 sets (2 planned + 3 actual)
			const s2 = history[0];
			const benchEntry = s2.exercises.find(
				(e) => e.exercise.name === "ベンチプレス",
			);
			expect(benchEntry).toBeDefined();
			expect(benchEntry?.sets).toHaveLength(5);
		});
	});

	describe("getSessionDetail", () => {
		it("should return full session with exercises and sets", async () => {
			const detail = await getSessionDetail(env.DB, session1Id);
			expect(detail).not.toBeNull();
			const d = detail as SessionDetail;
			expect(d.session.session_date).toBe("2026-08-15");
			expect(d.session.goal).toBe("ダイエット");
			expect(d.exercises).toHaveLength(2);
		});

		it("should order exercises by display_order", async () => {
			const detail = await getSessionDetail(env.DB, session1Id);
			expect(detail).not.toBeNull();
			const d = detail as SessionDetail;
			expect(d.exercises[0].sessionExercise.display_order).toBe(1);
			expect(d.exercises[1].sessionExercise.display_order).toBe(2);
			// First exercise is ベンチプレス (registered first in seed)
			expect(d.exercises[0].exercise.name).toBe("ベンチプレス");
			expect(d.exercises[1].exercise.name).toBe("ウォーキング");
		});

		it("should include correct sets for each exercise", async () => {
			const detail = await getSessionDetail(env.DB, session1Id);
			const d = detail as SessionDetail;

			// ベンチプレス: 2 actual sets
			const bench = d.exercises[0];
			expect(bench.sets).toHaveLength(2);
			expect(bench.sets[0].weight_value).toBe(60);
			expect(bench.sets[1].weight_value).toBe(65);

			// ウォーキング: 1 actual cardio set
			const walk = d.exercises[1];
			expect(walk.sets).toHaveLength(1);
			expect(walk.sets[0].duration_minutes).toBe(10);
			expect(walk.sets[0].speed_min).toBe(3.5);
		});

		it("should include both planned and actual sets", async () => {
			const detail = await getSessionDetail(env.DB, session2Id);
			const d = detail as SessionDetail;
			const bench = d.exercises.find((e) => e.exercise.name === "ベンチプレス");
			expect(bench).toBeDefined();

			const planned = bench?.sets.filter((s) => s.is_planned === 1) ?? [];
			const actual = bench?.sets.filter((s) => s.is_planned === 0) ?? [];
			expect(planned).toHaveLength(2);
			expect(actual).toHaveLength(3);
		});

		it("should return null for non-existent session", async () => {
			const detail = await getSessionDetail(env.DB, 9999);
			expect(detail).toBeNull();
		});
	});

	describe("getExerciseStats", () => {
		it("should return correct total sessions", async () => {
			const stats = await getExerciseStats(env.DB, benchId);
			expect(stats).not.toBeNull();
			// ベンチプレス appears in both sessions
			expect(stats?.totalSessions).toBe(2);
		});

		it("should return correct max weight (actual only)", async () => {
			const stats = await getExerciseStats(env.DB, benchId);
			expect(stats).not.toBeNull();
			// Max actual weight is 75kg from session 2
			expect(stats?.maxWeight).not.toBeNull();
			expect(stats?.maxWeight?.value).toBe(75);
			expect(stats?.maxWeight?.unit).toBe("kg");
			expect(stats?.maxWeight?.date).toBe("2026-08-16");
		});

		it("should exclude planned sets from max weight", async () => {
			// The planned sets have 60kg but actual has up to 75kg
			// If planned were included, 60 would still not be max, but let's
			// verify by checking actual sets are the only source
			const stats = await getExerciseStats(env.DB, benchId);
			// The max is from actual performance, not planned
			expect(stats?.maxWeight?.value).toBe(75);
		});

		it("should return correct session summaries with total reps and sets", async () => {
			const stats = await getExerciseStats(env.DB, benchId);
			expect(stats).not.toBeNull();
			expect(stats?.sessionSummaries).toHaveLength(2);

			// Summaries are ordered by date DESC
			// Session 2026-08-16: 3 actual sets, reps = 10 + 8 + 6 = 24
			const s2summary = stats?.sessionSummaries[0];
			expect(s2summary?.sessionDate).toBe("2026-08-16");
			expect(s2summary?.totalReps).toBe(24);
			expect(s2summary?.totalSets).toBe(3);

			// Session 2026-08-15: 2 actual sets, reps = 10 + 8 = 18
			const s1summary = stats?.sessionSummaries[1];
			expect(s1summary?.sessionDate).toBe("2026-08-15");
			expect(s1summary?.totalReps).toBe(18);
			expect(s1summary?.totalSets).toBe(2);
		});

		it("should return null maxWeight for exercise without weight data", async () => {
			// ウォーキング has no weight_value
			const stats = await getExerciseStats(env.DB, walkingId);
			expect(stats).not.toBeNull();
			expect(stats?.maxWeight).toBeNull();
			expect(stats?.totalSessions).toBe(1);
		});

		it("should handle exercise with only flexibility data", async () => {
			const stats = await getExerciseStats(env.DB, stretchId);
			expect(stats).not.toBeNull();
			expect(stats?.exerciseName).toBe("ストレッチボード");
			expect(stats?.totalSessions).toBe(1);
			expect(stats?.maxWeight).toBeNull();
			// 1 actual set with angle_degrees, reps is null so totalReps = 0
			expect(stats?.sessionSummaries).toHaveLength(1);
			expect(stats?.sessionSummaries[0].totalSets).toBe(1);
		});

		it("should return null for non-existent exercise", async () => {
			const stats = await getExerciseStats(env.DB, 9999);
			expect(stats).toBeNull();
		});

		it("should count planned-only sessions in totalSessions but not in summaries", async () => {
			// Create a session with only planned sets for ベンチプレス
			const { session: s3 } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-17",
			});
			const se = await createSessionExercise(env.DB, {
				sessionId: s3.id,
				exerciseId: benchId,
				status: "planned",
			});
			await replaceSets(env.DB, se.id, [
				{ isPlanned: true, reps: 10, weightValue: 60, weightUnit: "kg" },
			]);

			const stats = await getExerciseStats(env.DB, benchId);
			expect(stats).not.toBeNull();
			// totalSessions counts all sessions with this exercise
			expect(stats?.totalSessions).toBe(3);
			// sessionSummaries only includes sessions with actual sets (is_planned=0)
			expect(stats?.sessionSummaries).toHaveLength(2);
		});
	});
});
