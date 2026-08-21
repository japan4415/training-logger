import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	registerExerciseHandler,
	searchExercisesHandler,
} from "../../../src/mcp/tools/exercises.js";
import { applyMigrations, cleanDatabase } from "../../db/test-helpers.js";

describe("MCP exercise tool handlers", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	describe("searchExercisesHandler", () => {
		it("should return empty array when no exercises registered", async () => {
			const result = await searchExercisesHandler(env, {});
			expect(result.exercises).toHaveLength(0);
		});

		it("should return all exercises when no query", async () => {
			await registerExerciseHandler(env, { name: "ベンチプレス" });
			await registerExerciseHandler(env, {
				name: "ウォーキング",
				category: "cardio",
			});

			const result = await searchExercisesHandler(env, {});
			expect(result.exercises).toHaveLength(2);
		});

		it("should search by name partial match", async () => {
			await registerExerciseHandler(env, {
				name: "カイザーチェストプレス",
			});
			await registerExerciseHandler(env, { name: "ベンチプレス" });

			const result = await searchExercisesHandler(env, {
				query: "チェスト",
			});
			expect(result.exercises).toHaveLength(1);
			expect(result.exercises[0].name).toBe("カイザーチェストプレス");
		});

		it("should filter by category", async () => {
			await registerExerciseHandler(env, { name: "ベンチプレス" });
			await registerExerciseHandler(env, {
				name: "ウォーキング",
				category: "cardio",
			});

			const result = await searchExercisesHandler(env, {
				category: "cardio",
			});
			expect(result.exercises).toHaveLength(1);
			expect(result.exercises[0].name).toBe("ウォーキング");
		});

		it("should combine query and category filter", async () => {
			await registerExerciseHandler(env, { name: "ベンチプレス" });
			await registerExerciseHandler(env, {
				name: "ウォーキング",
				category: "cardio",
			});

			const result = await searchExercisesHandler(env, {
				query: "ベンチ",
				category: "cardio",
			});
			expect(result.exercises).toHaveLength(0);
		});

		it("should include aliases in results", async () => {
			await registerExerciseHandler(env, {
				name: "カイザーチェストプレス",
				aliases: ["Keiser Chest Press", "カイザーCP"],
			});

			const result = await searchExercisesHandler(env, {
				query: "カイザーチェストプレス",
			});
			expect(result.exercises).toHaveLength(1);
			expect(result.exercises[0].aliases).toEqual([
				"Keiser Chest Press",
				"カイザーCP",
			]);
		});

		it("should return result in correct shape", async () => {
			await registerExerciseHandler(env, {
				name: "ベンチプレス",
				equipment: "バーベル",
				target_muscles: "胸",
			});

			const result = await searchExercisesHandler(env, {
				query: "ベンチプレス",
			});
			const exercise = result.exercises[0];
			expect(exercise).toHaveProperty("id");
			expect(exercise).toHaveProperty("name");
			expect(exercise).toHaveProperty("category");
			expect(exercise).toHaveProperty("equipment");
			expect(exercise).toHaveProperty("target_muscles");
			expect(exercise).toHaveProperty("aliases");
			expect(exercise.equipment).toBe("バーベル");
			expect(exercise.target_muscles).toBe("胸");
		});
	});

	describe("registerExerciseHandler", () => {
		it("should register a basic exercise", async () => {
			const result = await registerExerciseHandler(env, {
				name: "ベンチプレス",
			});
			expect(result.exercise.name).toBe("ベンチプレス");
			expect(result.exercise.category).toBe("strength");
			expect(result.exercise.id).toBeGreaterThan(0);
			expect(result.exercise.aliases).toHaveLength(0);
		});

		it("should register with all optional fields", async () => {
			const result = await registerExerciseHandler(env, {
				name: "カイザーチェストプレス",
				category: "strength",
				equipment: "カイザー空圧マシン",
				target_muscles: "胸",
			});
			expect(result.exercise.equipment).toBe("カイザー空圧マシン");
			expect(result.exercise.target_muscles).toBe("胸");
		});

		it("should register with aliases", async () => {
			const result = await registerExerciseHandler(env, {
				name: "カイザーチェストプレス",
				aliases: ["Keiser Chest Press", "カイザーCP"],
			});
			expect(result.exercise.aliases).toEqual([
				"Keiser Chest Press",
				"カイザーCP",
			]);
		});

		it("should throw on duplicate name", async () => {
			await registerExerciseHandler(env, { name: "ベンチプレス" });
			await expect(
				registerExerciseHandler(env, { name: "ベンチプレス" }),
			).rejects.toThrow();
		});

		it("should throw on duplicate alias", async () => {
			await registerExerciseHandler(env, {
				name: "種目A",
				aliases: ["共通エイリアス"],
			});
			await expect(
				registerExerciseHandler(env, {
					name: "種目B",
					aliases: ["共通エイリアス"],
				}),
			).rejects.toThrow();
		});

		it("should default category to strength", async () => {
			const result = await registerExerciseHandler(env, {
				name: "テスト種目",
			});
			expect(result.exercise.category).toBe("strength");
		});

		it("should accept non-default category", async () => {
			const result = await registerExerciseHandler(env, {
				name: "ウォーキング",
				category: "cardio",
			});
			expect(result.exercise.category).toBe("cardio");
		});

		it("registered exercise should be searchable", async () => {
			await registerExerciseHandler(env, {
				name: "カイザーチェストプレス",
				aliases: ["カイザーCP"],
			});

			// Search by name
			const byName = await searchExercisesHandler(env, {
				query: "カイザーチェストプレス",
			});
			expect(byName.exercises).toHaveLength(1);

			// Search by alias
			const byAlias = await searchExercisesHandler(env, {
				query: "カイザーCP",
			});
			expect(byAlias.exercises).toHaveLength(1);
			expect(byAlias.exercises[0].name).toBe("カイザーチェストプレス");
		});
	});
});
