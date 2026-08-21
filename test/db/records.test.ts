import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExercise } from "../../src/db/exercises.js";
import {
	createSessionExercise,
	createSet,
	deleteSessionExercise,
	deleteSetsBySessionExercise,
	replaceSets,
	updateSessionExercise,
} from "../../src/db/records.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

describe("records", () => {
	let sessionId: number;
	let exerciseId: number;

	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);

		const { exercise } = await registerExercise(env.DB, {
			name: "ベンチプレス",
			category: "strength",
		});
		exerciseId = exercise.id;

		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-08-15",
		});
		sessionId = session.id;
	});

	describe("createSessionExercise", () => {
		it("should create with auto display_order starting from 1", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			expect(se.display_order).toBe(1);
			expect(se.session_id).toBe(sessionId);
			expect(se.exercise_id).toBe(exerciseId);
			expect(se.status).toBe("completed");
		});

		it("should auto-increment display_order within a session", async () => {
			const se1 = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const { exercise: exercise2 } = await registerExercise(env.DB, {
				name: "スクワット",
			});
			const se2 = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId: exercise2.id,
			});
			const { exercise: exercise3 } = await registerExercise(env.DB, {
				name: "デッドリフト",
			});
			const se3 = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId: exercise3.id,
			});

			expect(se1.display_order).toBe(1);
			expect(se2.display_order).toBe(2);
			expect(se3.display_order).toBe(3);
		});

		it("should have independent display_order per session", async () => {
			await createSessionExercise(env.DB, { sessionId, exerciseId });

			const { session: session2 } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-16",
			});
			const se = await createSessionExercise(env.DB, {
				sessionId: session2.id,
				exerciseId,
			});
			// Different session, display_order starts from 1
			expect(se.display_order).toBe(1);
		});

		it("should save optional fields", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
				status: "planned",
				equipmentNote: "2kgバー",
				formCues: "背中の空間をつぶす\n肩を上げない",
				notes: "テストメモ",
			});
			expect(se.status).toBe("planned");
			expect(se.equipment_note).toBe("2kgバー");
			expect(se.form_cues).toBe("背中の空間をつぶす\n肩を上げない");
			expect(se.notes).toBe("テストメモ");
		});
	});

	describe("updateSessionExercise", () => {
		it("should update specified fields only", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
				notes: "元のメモ",
				equipmentNote: "元の器具",
			});

			const updated = await updateSessionExercise(env.DB, se.id, {
				status: "skipped",
			});

			expect(updated).not.toBeNull();
			expect(updated?.status).toBe("skipped");
			expect(updated?.notes).toBe("元のメモ");
			expect(updated?.equipment_note).toBe("元の器具");
		});

		it("should allow setting fields to null", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
				notes: "元のメモ",
			});

			const updated = await updateSessionExercise(env.DB, se.id, {
				notes: null,
			});
			expect(updated?.notes).toBeNull();
		});

		it("should return null for non-existent ID", async () => {
			const result = await updateSessionExercise(env.DB, 9999, {
				status: "skipped",
			});
			expect(result).toBeNull();
		});
	});

	describe("deleteSessionExercise", () => {
		it("should delete a session exercise and return true", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const deleted = await deleteSessionExercise(env.DB, se.id);
			expect(deleted).toBe(true);
		});

		it("should return false for non-existent ID", async () => {
			const deleted = await deleteSessionExercise(env.DB, 9999);
			expect(deleted).toBe(false);
		});

		it("should cascade delete associated sets", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 10,
			});

			await deleteSessionExercise(env.DB, se.id);

			const { results } = await env.DB.prepare(
				"SELECT * FROM sets WHERE session_exercise_id = ?",
			)
				.bind(se.id)
				.all();
			expect(results).toHaveLength(0);
		});
	});

	describe("createSet", () => {
		it("should create a strength set", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const set = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 10,
				weightValue: 60,
				weightUnit: "kg",
			});
			expect(set.reps).toBe(10);
			expect(set.weight_value).toBe(60);
			expect(set.weight_unit).toBe("kg");
			expect(set.is_planned).toBe(0);
		});

		it("should create a planned set", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const set = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				isPlanned: true,
				reps: 20,
			});
			expect(set.is_planned).toBe(1);
			expect(set.reps).toBe(20);
		});

		it("should create a bodyweight set (null weight)", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const set = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 20,
			});
			expect(set.weight_value).toBeNull();
			expect(set.weight_unit).toBeNull();
		});

		it("should create a cardio set", async () => {
			const { exercise: cardioEx } = await registerExercise(env.DB, {
				name: "ウォーキング",
				category: "cardio",
			});
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId: cardioEx.id,
			});
			const set = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				durationMinutes: 10,
				speedMin: 3.5,
				speedMax: 5.0,
				inclinePercent: 0.5,
			});
			expect(set.duration_minutes).toBe(10);
			expect(set.speed_min).toBe(3.5);
			expect(set.speed_max).toBe(5.0);
			expect(set.incline_percent).toBe(0.5);
		});

		it("should create a flexibility set", async () => {
			const { exercise: flexEx } = await registerExercise(env.DB, {
				name: "ストレッチボード",
				category: "flexibility",
			});
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId: flexEx.id,
			});
			const set = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				angleDegrees: 20,
			});
			expect(set.angle_degrees).toBe(20);
		});

		it("should create a machine level set", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const set = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 20,
				weightValue: 15,
				weightUnit: "level",
			});
			expect(set.weight_unit).toBe("level");
			expect(set.weight_value).toBe(15);
		});

		it("should enforce UNIQUE(session_exercise_id, set_order, is_planned)", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 10,
			});
			await expect(
				createSet(env.DB, {
					sessionExerciseId: se.id,
					setOrder: 1,
					reps: 15,
				}),
			).rejects.toThrow();
		});

		it("should allow same set_order for different is_planned values", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const planned = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				isPlanned: true,
				reps: 20,
			});
			const actual = await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				isPlanned: false,
				reps: 15,
			});
			expect(planned.is_planned).toBe(1);
			expect(actual.is_planned).toBe(0);
			expect(planned.set_order).toBe(1);
			expect(actual.set_order).toBe(1);
		});
	});

	describe("replaceSets", () => {
		it("should replace all existing sets with new ones", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});

			// Create initial sets
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 10,
			});
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 2,
				reps: 10,
			});

			// Replace with new sets
			const newSets = await replaceSets(env.DB, se.id, [
				{ reps: 15, weightValue: 60, weightUnit: "kg" },
				{ reps: 12, weightValue: 65, weightUnit: "kg" },
				{ reps: 10, weightValue: 70, weightUnit: "kg" },
			]);

			expect(newSets).toHaveLength(3);
			expect(newSets[0].set_order).toBe(1);
			expect(newSets[0].reps).toBe(15);
			expect(newSets[0].weight_value).toBe(60);
			expect(newSets[1].set_order).toBe(2);
			expect(newSets[1].reps).toBe(12);
			expect(newSets[2].set_order).toBe(3);
			expect(newSets[2].reps).toBe(10);
		});

		it("should number set_order independently for planned and actual", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});

			// Replicate the leg raise example from database.md:
			// planned: 20x2, actual: 20/10/10
			const sets = await replaceSets(env.DB, se.id, [
				{ isPlanned: true, reps: 20 },
				{ isPlanned: true, reps: 20 },
				{ isPlanned: false, reps: 20 },
				{ isPlanned: false, reps: 10 },
				{ isPlanned: false, reps: 10 },
			]);

			expect(sets).toHaveLength(5);

			// Actual sets (is_planned=0) come first in ORDER BY is_planned, set_order
			const actual = sets.filter((s) => s.is_planned === 0);
			expect(actual).toHaveLength(3);
			expect(actual[0].set_order).toBe(1);
			expect(actual[0].reps).toBe(20);
			expect(actual[1].set_order).toBe(2);
			expect(actual[1].reps).toBe(10);
			expect(actual[2].set_order).toBe(3);
			expect(actual[2].reps).toBe(10);

			// Planned sets (is_planned=1)
			const planned = sets.filter((s) => s.is_planned === 1);
			expect(planned).toHaveLength(2);
			expect(planned[0].set_order).toBe(1);
			expect(planned[0].reps).toBe(20);
			expect(planned[1].set_order).toBe(2);
			expect(planned[1].reps).toBe(20);
		});

		it("should handle empty set array (delete all)", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 10,
			});

			const result = await replaceSets(env.DB, se.id, []);
			expect(result).toHaveLength(0);

			// Verify no sets remain
			const { results } = await env.DB.prepare(
				"SELECT * FROM sets WHERE session_exercise_id = ?",
			)
				.bind(se.id)
				.all();
			expect(results).toHaveLength(0);
		});

		it("should handle replace with no prior sets", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const sets = await replaceSets(env.DB, se.id, [
				{ reps: 10, weightValue: 60, weightUnit: "kg" },
			]);
			expect(sets).toHaveLength(1);
			expect(sets[0].set_order).toBe(1);
		});
	});

	describe("deleteSetsBySessionExercise", () => {
		it("should delete all sets for a session exercise", async () => {
			const se = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 1,
				reps: 10,
			});
			await createSet(env.DB, {
				sessionExerciseId: se.id,
				setOrder: 2,
				reps: 10,
			});

			await deleteSetsBySessionExercise(env.DB, se.id);

			const { results } = await env.DB.prepare(
				"SELECT * FROM sets WHERE session_exercise_id = ?",
			)
				.bind(se.id)
				.all();
			expect(results).toHaveLength(0);
		});

		it("should not affect sets of other session exercises", async () => {
			const se1 = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId,
			});
			const { exercise: exercise2 } = await registerExercise(env.DB, {
				name: "スクワット",
			});
			const se2 = await createSessionExercise(env.DB, {
				sessionId,
				exerciseId: exercise2.id,
			});

			await createSet(env.DB, {
				sessionExerciseId: se1.id,
				setOrder: 1,
				reps: 10,
			});
			await createSet(env.DB, {
				sessionExerciseId: se2.id,
				setOrder: 1,
				reps: 15,
			});

			await deleteSetsBySessionExercise(env.DB, se1.id);

			// se2's sets should remain
			const { results } = await env.DB.prepare(
				"SELECT * FROM sets WHERE session_exercise_id = ?",
			)
				.bind(se2.id)
				.all();
			expect(results).toHaveLength(1);
		});
	});
});
