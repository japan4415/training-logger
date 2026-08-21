import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findExerciseByName } from "../../../src/db/exercises.js";
import { getSessionByDate } from "../../../src/db/sessions.js";
import {
	deleteWorkoutHandler,
	getTodayDateJST,
	logWorkoutHandler,
	updateWorkoutHandler,
} from "../../../src/mcp/tools/workouts.js";
import { applyMigrations, cleanDatabase } from "../../db/test-helpers.js";

describe("workout tools", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	describe("getTodayDateJST", () => {
		it("should return Asia/Tokyo date in YYYY-MM-DD format", () => {
			const date = getTodayDateJST();
			expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});

	describe("logWorkoutHandler", () => {
		it("should log a simple workout with explicit date", async () => {
			const result = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [
							{ reps: 10, weight: 60, weight_unit: "kg" },
							{ reps: 10, weight: 60, weight_unit: "kg" },
						],
					},
				],
			});

			expect(result.date).toBe("2026-08-15");
			expect(result.exercises_logged).toBe(1);
			expect(result.sets_logged).toBe(2);
			expect(result.auto_registered).toContain("ベンチプレス");
		});

		it("should append exercises when called twice on the same day", async () => {
			// First call
			const result1 = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10, weight: 60, weight_unit: "kg" }],
					},
				],
			});

			// Second call - same date, different exercise
			const result2 = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "スクワット",
						sets: [{ reps: 10, weight: 80, weight_unit: "kg" }],
					},
				],
			});

			// Same session ID (no duplicate session)
			expect(result2.session_id).toBe(result1.session_id);

			// Verify both exercises exist in the session
			const { results: sessionExercises } = await env.DB.prepare(
				"SELECT * FROM session_exercises WHERE session_id = ? ORDER BY display_order",
			)
				.bind(result1.session_id)
				.all();

			expect(sessionExercises).toHaveLength(2);
		});

		it("should auto-register unknown exercises as strength by default", async () => {
			const result = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "新種目テスト",
						sets: [{ reps: 15, weight: 20, weight_unit: "kg" }],
					},
				],
			});

			expect(result.auto_registered).toContain("新種目テスト");

			const exercise = await findExerciseByName(env.DB, "新種目テスト");
			expect(exercise).not.toBeNull();
			expect(exercise?.category).toBe("strength");
		});

		it("should auto-register exercises with cardio params as cardio", async () => {
			const result = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ランニング",
						sets: [
							{
								duration_minutes: 30,
								speed_min: 8.0,
								speed_max: 12.0,
							},
						],
					},
				],
			});

			expect(result.auto_registered).toContain("ランニング");

			const exercise = await findExerciseByName(env.DB, "ランニング");
			expect(exercise).not.toBeNull();
			expect(exercise?.category).toBe("cardio");
		});

		it("should infer cardio from duration_minutes alone", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "サイクリング",
						sets: [{ duration_minutes: 45 }],
					},
				],
			});

			const exercise = await findExerciseByName(env.DB, "サイクリング");
			expect(exercise?.category).toBe("cardio");
		});

		it("should use Asia/Tokyo date when date is omitted", async () => {
			const result = await logWorkoutHandler(env, {
				exercises: [
					{
						name: "テスト種目",
						sets: [{ reps: 10 }],
					},
				],
			});

			// The date should match getTodayDateJST()
			const expectedDate = getTodayDateJST();
			expect(result.date).toBe(expectedDate);
		});

		it("should correctly handle is_planned boolean to 0/1 conversion", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "レッグレイズ",
						sets: [
							{ reps: 20, is_planned: true },
							{ reps: 20, is_planned: true },
							{ reps: 20, is_planned: false },
							{ reps: 10, is_planned: false },
						],
					},
				],
			});

			// Verify is_planned values in the DB (should be 0 or 1, not boolean)
			const { results: sets } = await env.DB.prepare(
				`SELECT s.is_planned, s.reps, s.set_order FROM sets s
				 JOIN session_exercises se ON s.session_exercise_id = se.id
				 JOIN workout_sessions ws ON se.session_id = ws.id
				 WHERE ws.session_date = '2026-08-15'
				 ORDER BY s.is_planned, s.set_order`,
			).all<{ is_planned: number; reps: number; set_order: number }>();

			// Actual sets (is_planned=0) first
			const actual = sets.filter((s) => s.is_planned === 0);
			expect(actual).toHaveLength(2);
			expect(actual[0].set_order).toBe(1);
			expect(actual[0].reps).toBe(20);
			expect(actual[1].set_order).toBe(2);
			expect(actual[1].reps).toBe(10);

			// Planned sets (is_planned=1)
			const planned = sets.filter((s) => s.is_planned === 1);
			expect(planned).toHaveLength(2);
			expect(planned[0].set_order).toBe(1);
			expect(planned[0].reps).toBe(20);
			expect(planned[1].set_order).toBe(2);
			expect(planned[1].reps).toBe(20);

			// Ensure DB stores integers, not booleans
			for (const s of sets) {
				expect(typeof s.is_planned).toBe("number");
				expect(s.is_planned === 0 || s.is_planned === 1).toBe(true);
			}
		});

		it("should handle weight -> weight_value mapping correctly", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ダンベルカール",
						sets: [{ reps: 12, weight: 10, weight_unit: "kg" }],
					},
				],
			});

			const { results: sets } = await env.DB.prepare(
				`SELECT s.weight_value, s.weight_unit FROM sets s
				 JOIN session_exercises se ON s.session_exercise_id = se.id
				 JOIN workout_sessions ws ON se.session_id = ws.id
				 WHERE ws.session_date = '2026-08-15'`,
			).all<{ weight_value: number; weight_unit: string }>();

			expect(sets).toHaveLength(1);
			expect(sets[0].weight_value).toBe(10);
			expect(sets[0].weight_unit).toBe("kg");
		});

		it("should not auto-register an already registered exercise", async () => {
			// First call auto-registers
			const result1 = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "既存種目",
						sets: [{ reps: 10 }],
					},
				],
			});
			expect(result1.auto_registered).toContain("既存種目");

			// Second call should find existing
			const result2 = await logWorkoutHandler(env, {
				date: "2026-08-16",
				exercises: [
					{
						name: "既存種目",
						sets: [{ reps: 10 }],
					},
				],
			});
			expect(result2.auto_registered).not.toContain("既存種目");
		});

		it("should save session metadata (goal, body_condition, session_notes)", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				goal: "ダイエット",
				body_condition: "良好",
				session_notes: "テストメモ",
				exercises: [
					{
						name: "テスト種目",
						sets: [{ reps: 10 }],
					},
				],
			});

			const session = await getSessionByDate(env.DB, "2026-08-15");
			expect(session?.goal).toBe("ダイエット");
			expect(session?.body_condition).toBe("良好");
			expect(session?.notes).toBe("テストメモ");
		});

		it("should update session metadata when appending to existing session", async () => {
			// First call creates session without goal
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "テスト種目A",
						sets: [{ reps: 10 }],
					},
				],
			});

			// Second call provides goal
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				goal: "筋力アップ",
				exercises: [
					{
						name: "テスト種目B",
						sets: [{ reps: 10 }],
					},
				],
			});

			const session = await getSessionByDate(env.DB, "2026-08-15");
			expect(session?.goal).toBe("筋力アップ");
		});

		it("should save exercise-level metadata", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "シーテッドロウ",
						equipment_note: "2kgバー",
						form_cues: "背中の空間をつぶす",
						notes: "テスト",
						sets: [{ reps: 15, weight: 16, weight_unit: "kg" }],
					},
				],
			});

			const { results } = await env.DB.prepare(
				`SELECT se.equipment_note, se.form_cues, se.notes
				 FROM session_exercises se
				 JOIN workout_sessions ws ON se.session_id = ws.id
				 WHERE ws.session_date = '2026-08-15'`,
			).all<{
				equipment_note: string | null;
				form_cues: string | null;
				notes: string | null;
			}>();

			expect(results).toHaveLength(1);
			expect(results[0].equipment_note).toBe("2kgバー");
			expect(results[0].form_cues).toBe("背中の空間をつぶす");
			expect(results[0].notes).toBe("テスト");
		});

		it("should handle multiple exercises in a single call", async () => {
			const result = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ウォーキング",
						sets: [
							{
								duration_minutes: 10,
								speed_min: 3.5,
								speed_max: 5.0,
								incline_percent: 0.5,
							},
						],
					},
					{
						name: "ベンチプレス",
						sets: [
							{ reps: 10, weight: 60, weight_unit: "kg" },
							{ reps: 10, weight: 60, weight_unit: "kg" },
						],
					},
					{
						name: "ストレッチボード",
						sets: [{ angle_degrees: 20 }],
					},
				],
			});

			expect(result.exercises_logged).toBe(3);
			expect(result.sets_logged).toBe(4);
		});
	});

	describe("updateWorkoutHandler", () => {
		it("should update exercise metadata by name", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10, weight: 60, weight_unit: "kg" }],
					},
				],
			});

			const result = await updateWorkoutHandler(env, {
				date: "2026-08-15",
				exercise_name: "ベンチプレス",
				equipment_note: "バーベル",
				form_cues: "肩甲骨を寄せる",
			});

			expect(result.updated_fields).toContain("equipment_note");
			expect(result.updated_fields).toContain("form_cues");
			expect(result.sets_replaced).toBe(false);
		});

		it("should replace sets when provided", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [
							{ reps: 10, weight: 60, weight_unit: "kg" },
							{ reps: 10, weight: 60, weight_unit: "kg" },
						],
					},
				],
			});

			const result = await updateWorkoutHandler(env, {
				date: "2026-08-15",
				exercise_name: "ベンチプレス",
				sets: [
					{ reps: 8, weight: 70, weight_unit: "kg" },
					{ reps: 6, weight: 80, weight_unit: "kg" },
					{ reps: 4, weight: 90, weight_unit: "kg" },
				],
			});

			expect(result.sets_replaced).toBe(true);

			// Verify the sets were replaced
			const { results: sets } = await env.DB.prepare(
				`SELECT s.reps, s.weight_value FROM sets s
				 WHERE s.session_exercise_id = ?
				 ORDER BY s.set_order`,
			)
				.bind(result.session_exercise_id)
				.all<{ reps: number; weight_value: number }>();

			expect(sets).toHaveLength(3);
			expect(sets[0].reps).toBe(8);
			expect(sets[0].weight_value).toBe(70);
			expect(sets[2].reps).toBe(4);
			expect(sets[2].weight_value).toBe(90);
		});

		it("should error when date has no session", async () => {
			await expect(
				updateWorkoutHandler(env, {
					date: "2099-01-01",
					exercise_name: "ベンチプレス",
				}),
			).rejects.toThrow("No session found");
		});

		it("should error when exercise name not found in session", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10 }],
					},
				],
			});

			await expect(
				updateWorkoutHandler(env, {
					date: "2026-08-15",
					exercise_name: "存在しない種目",
				}),
			).rejects.toThrow("not found");
		});

		it("should require exercise_order when same-name exercises exist", async () => {
			// Log same exercise twice (e.g., walking at start and end)
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ウォーキング",
						sets: [{ duration_minutes: 10, speed_min: 3.5, speed_max: 5.0 }],
					},
					{
						name: "ウォーキング",
						sets: [{ duration_minutes: 10, speed_min: 4.0, speed_max: 5.5 }],
					},
				],
			});

			// Should fail without exercise_order
			await expect(
				updateWorkoutHandler(env, {
					date: "2026-08-15",
					exercise_name: "ウォーキング",
					notes: "更新テスト",
				}),
			).rejects.toThrow("Multiple entries");

			// Should succeed with exercise_order
			const result = await updateWorkoutHandler(env, {
				date: "2026-08-15",
				exercise_name: "ウォーキング",
				exercise_order: 2,
				notes: "2回目のウォーキング",
			});

			expect(result.updated_fields).toContain("notes");
		});

		it("should update by session_exercise_id directly", async () => {
			const logResult = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10, weight: 60, weight_unit: "kg" }],
					},
				],
			});

			// Get the session_exercise_id
			const { results } = await env.DB.prepare(
				"SELECT id FROM session_exercises WHERE session_id = ?",
			)
				.bind(logResult.session_id)
				.all<{ id: number }>();

			const result = await updateWorkoutHandler(env, {
				date: "2026-08-15",
				session_exercise_id: results[0].id,
				status: "skipped",
			});

			expect(result.updated_fields).toContain("status");
		});
	});

	describe("deleteWorkoutHandler", () => {
		it("should delete entire session", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10, weight: 60, weight_unit: "kg" }],
					},
					{
						name: "スクワット",
						sets: [{ reps: 10, weight: 80, weight_unit: "kg" }],
					},
				],
			});

			const result = await deleteWorkoutHandler(env, {
				date: "2026-08-15",
				delete_entire_session: true,
			});

			expect(result.deleted).toBe("session");

			const session = await getSessionByDate(env.DB, "2026-08-15");
			expect(session).toBeNull();
		});

		it("should delete specific exercise by name", async () => {
			const logResult = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10, weight: 60, weight_unit: "kg" }],
					},
					{
						name: "スクワット",
						sets: [{ reps: 10, weight: 80, weight_unit: "kg" }],
					},
				],
			});

			const result = await deleteWorkoutHandler(env, {
				date: "2026-08-15",
				exercise_name: "ベンチプレス",
			});

			expect(result.deleted).toBe("exercise");
			expect(result.exercise_name).toBe("ベンチプレス");

			// Session should still exist
			const session = await getSessionByDate(env.DB, "2026-08-15");
			expect(session).not.toBeNull();

			// Only squat should remain
			const { results: exercises } = await env.DB.prepare(
				"SELECT * FROM session_exercises WHERE session_id = ?",
			)
				.bind(logResult.session_id)
				.all();
			expect(exercises).toHaveLength(1);
		});

		it("should error when date has no session", async () => {
			await expect(
				deleteWorkoutHandler(env, {
					date: "2099-01-01",
					delete_entire_session: true,
				}),
			).rejects.toThrow("No session found");
		});

		it("should cascade delete sets when deleting exercise", async () => {
			await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [
							{ reps: 10, weight: 60, weight_unit: "kg" },
							{ reps: 8, weight: 70, weight_unit: "kg" },
						],
					},
				],
			});

			await deleteWorkoutHandler(env, {
				date: "2026-08-15",
				exercise_name: "ベンチプレス",
			});

			// No sets should remain
			const { results: sets } =
				await env.DB.prepare("SELECT * FROM sets").all();
			expect(sets).toHaveLength(0);
		});

		it("should delete exercise by session_exercise_id", async () => {
			const logResult = await logWorkoutHandler(env, {
				date: "2026-08-15",
				exercises: [
					{
						name: "ベンチプレス",
						sets: [{ reps: 10 }],
					},
				],
			});

			const { results } = await env.DB.prepare(
				"SELECT id FROM session_exercises WHERE session_id = ?",
			)
				.bind(logResult.session_id)
				.all<{ id: number }>();

			const result = await deleteWorkoutHandler(env, {
				date: "2026-08-15",
				session_exercise_id: results[0].id,
			});

			expect(result.deleted).toBe("exercise");
		});
	});
});
