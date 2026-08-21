import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	findExerciseByName,
	getExerciseAliases,
	getExerciseById,
	registerExercise,
	searchExercises,
} from "../../src/db/exercises.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

describe("exercises", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	describe("registerExercise", () => {
		it("should register a basic exercise with defaults", async () => {
			const result = await registerExercise(env.DB, {
				name: "ベンチプレス",
			});
			expect(result.exercise.name).toBe("ベンチプレス");
			expect(result.exercise.category).toBe("strength");
			expect(result.exercise.equipment).toBeNull();
			expect(result.exercise.target_muscles).toBeNull();
			expect(result.aliases).toHaveLength(0);
			expect(result.exercise.id).toBeGreaterThan(0);
		});

		it("should register an exercise with all fields", async () => {
			const result = await registerExercise(env.DB, {
				name: "カイザーチェストプレス",
				category: "strength",
				equipment: "カイザー空圧マシン",
				target_muscles: "胸",
				notes: "テストメモ",
			});
			expect(result.exercise.equipment).toBe("カイザー空圧マシン");
			expect(result.exercise.target_muscles).toBe("胸");
			expect(result.exercise.notes).toBe("テストメモ");
		});

		it("should register an exercise with aliases", async () => {
			const result = await registerExercise(env.DB, {
				name: "カイザーチェストプレス",
				aliases: ["Keiser Chest Press", "カイザーCP"],
			});
			expect(result.aliases).toHaveLength(2);
			expect(result.aliases[0].alias).toBe("Keiser Chest Press");
			expect(result.aliases[1].alias).toBe("カイザーCP");
			expect(result.aliases[0].exercise_id).toBe(result.exercise.id);
		});

		it("should reject duplicate exercise names", async () => {
			await registerExercise(env.DB, { name: "ベンチプレス" });
			await expect(
				registerExercise(env.DB, { name: "ベンチプレス" }),
			).rejects.toThrow();
		});

		it("should reject duplicate alias names", async () => {
			await registerExercise(env.DB, {
				name: "種目A",
				aliases: ["共通エイリアス"],
			});
			await expect(
				registerExercise(env.DB, {
					name: "種目B",
					aliases: ["共通エイリアス"],
				}),
			).rejects.toThrow();
		});
	});

	describe("searchExercises", () => {
		beforeEach(async () => {
			await registerExercise(env.DB, {
				name: "カイザーチェストプレス",
				category: "strength",
				equipment: "カイザー空圧マシン",
				aliases: ["Keiser Chest Press", "カイザーCP"],
			});
			await registerExercise(env.DB, {
				name: "ウォーキング",
				category: "cardio",
			});
			await registerExercise(env.DB, {
				name: "ストレッチボード",
				category: "flexibility",
			});
		});

		it("should return all exercises when no query", async () => {
			const results = await searchExercises(env.DB);
			expect(results).toHaveLength(3);
		});

		it("should find by exact name (stage 1)", async () => {
			const results = await searchExercises(env.DB, "カイザーチェストプレス");
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("カイザーチェストプレス");
		});

		it("should find by exact alias (stage 2)", async () => {
			const results = await searchExercises(env.DB, "Keiser Chest Press");
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("カイザーチェストプレス");
		});

		it("should include aliases in result", async () => {
			const results = await searchExercises(env.DB, "カイザーチェストプレス");
			expect(results[0].aliases).toHaveLength(2);
			expect(results[0].aliases.map((a) => a.alias)).toContain(
				"Keiser Chest Press",
			);
			expect(results[0].aliases.map((a) => a.alias)).toContain("カイザーCP");
		});

		it("should find by partial match (stage 3)", async () => {
			const results = await searchExercises(env.DB, "チェスト");
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("カイザーチェストプレス");
		});

		it("should find by partial alias match (stage 3)", async () => {
			const results = await searchExercises(env.DB, "Keiser");
			// Stage 1 fails (no exact name match), Stage 2 fails (no exact alias), Stage 3 succeeds
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("カイザーチェストプレス");
		});

		it("should be case-insensitive for exact name match", async () => {
			// exercises.name has COLLATE NOCASE
			const results = await searchExercises(env.DB, "ウォーキング");
			expect(results).toHaveLength(1);
		});

		it("should be case-insensitive for exact alias match", async () => {
			const results = await searchExercises(env.DB, "keiser chest press");
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("カイザーチェストプレス");
		});

		it("should filter by category", async () => {
			const results = await searchExercises(env.DB, undefined, "cardio");
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("ウォーキング");
		});

		it("should combine query and category filter", async () => {
			// "カイザー" matches but is not cardio
			const results = await searchExercises(env.DB, "カイザー", "cardio");
			expect(results).toHaveLength(0);
		});

		it("should return empty array for no matches", async () => {
			const results = await searchExercises(env.DB, "存在しない種目");
			expect(results).toHaveLength(0);
		});

		it("should prioritize exact name over alias match", async () => {
			// Register another exercise whose alias is a name that exists
			await registerExercise(env.DB, {
				name: "ベンチプレス",
				aliases: ["ウォーキング代替"],
			});
			// Searching for exact name should return stage 1 result
			const results = await searchExercises(env.DB, "ベンチプレス");
			expect(results).toHaveLength(1);
			expect(results[0].exercise.name).toBe("ベンチプレス");
		});
	});

	describe("findExerciseByName", () => {
		beforeEach(async () => {
			await registerExercise(env.DB, {
				name: "カイザーチェストプレス",
				aliases: ["Keiser Chest Press"],
			});
		});

		it("should find by exact name (stage 1)", async () => {
			const result = await findExerciseByName(env.DB, "カイザーチェストプレス");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("カイザーチェストプレス");
		});

		it("should find by exact alias (stage 2)", async () => {
			const result = await findExerciseByName(env.DB, "Keiser Chest Press");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("カイザーチェストプレス");
		});

		it("should find by partial match (stage 3)", async () => {
			const result = await findExerciseByName(env.DB, "チェスト");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("カイザーチェストプレス");
		});

		it("should return null for no match", async () => {
			const result = await findExerciseByName(env.DB, "存在しない種目");
			expect(result).toBeNull();
		});
	});

	describe("getExerciseById", () => {
		it("should return exercise by ID", async () => {
			const { exercise } = await registerExercise(env.DB, {
				name: "テスト種目",
			});
			const result = await getExerciseById(env.DB, exercise.id);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("テスト種目");
		});

		it("should return null for non-existent ID", async () => {
			const result = await getExerciseById(env.DB, 9999);
			expect(result).toBeNull();
		});
	});

	describe("getExerciseAliases", () => {
		it("should return aliases for an exercise", async () => {
			const { exercise } = await registerExercise(env.DB, {
				name: "テスト種目",
				aliases: ["エイリアスA", "エイリアスB"],
			});
			const aliases = await getExerciseAliases(env.DB, exercise.id);
			expect(aliases).toHaveLength(2);
		});

		it("should return empty array for exercise without aliases", async () => {
			const { exercise } = await registerExercise(env.DB, {
				name: "テスト種目",
			});
			const aliases = await getExerciseAliases(env.DB, exercise.id);
			expect(aliases).toHaveLength(0);
		});
	});
});
