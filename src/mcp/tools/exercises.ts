import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerExercise, searchExercises } from "../../db/exercises.js";
import type { Bindings } from "../../env.js";

// ---- Response types ----

export interface SearchExercisesResult {
	exercises: Array<{
		id: number;
		name: string;
		category: string;
		equipment: string | null;
		target_muscles: string | null;
		aliases: string[];
	}>;
}

export interface RegisterExerciseResult {
	exercise: {
		id: number;
		name: string;
		category: string;
		equipment: string | null;
		target_muscles: string | null;
		aliases: string[];
	};
}

// ---- Handler params ----

export interface SearchExercisesParams {
	query?: string;
	category?: "strength" | "cardio" | "flexibility" | "other";
}

export interface RegisterExerciseParams {
	name: string;
	category?: "strength" | "cardio" | "flexibility" | "other";
	equipment?: string;
	target_muscles?: string;
	aliases?: string[];
}

// ---- Pure handler functions (testable without MCP) ----

export async function searchExercisesHandler(
	env: Bindings,
	params: SearchExercisesParams,
): Promise<SearchExercisesResult> {
	const results = await searchExercises(env.DB, params.query, params.category);

	return {
		exercises: results.map((r) => ({
			id: r.exercise.id,
			name: r.exercise.name,
			category: r.exercise.category,
			equipment: r.exercise.equipment,
			target_muscles: r.exercise.target_muscles,
			aliases: r.aliases.map((a) => a.alias),
		})),
	};
}

export async function registerExerciseHandler(
	env: Bindings,
	params: RegisterExerciseParams,
): Promise<RegisterExerciseResult> {
	const result = await registerExercise(env.DB, {
		name: params.name,
		category: params.category,
		equipment: params.equipment ?? null,
		target_muscles: params.target_muscles ?? null,
		aliases: params.aliases,
	});

	return {
		exercise: {
			id: result.exercise.id,
			name: result.exercise.name,
			category: result.exercise.category,
			equipment: result.exercise.equipment,
			target_muscles: result.exercise.target_muscles,
			aliases: result.aliases.map((a) => a.alias),
		},
	};
}

// ---- MCP tool registration ----

const categoryEnum = z.enum(["strength", "cardio", "flexibility", "other"]);

/**
 * Determine the best search query to find the existing exercise that caused
 * a UNIQUE constraint violation. When the collision is on exercise_aliases.alias,
 * search by each alias to find the conflicting one. Otherwise, search by name.
 */
async function findConflictingExercises(
	env: Bindings,
	name: string,
	aliases: string[] | undefined,
	errorMessage: string,
): Promise<SearchExercisesResult> {
	if (
		errorMessage.includes("exercise_aliases.alias") &&
		aliases &&
		aliases.length > 0
	) {
		// Search by each alias to find which one conflicts
		for (const alias of aliases) {
			const result = await searchExercisesHandler(env, { query: alias });
			if (result.exercises.length > 0) {
				return result;
			}
		}
	}
	// Default: search by the exercise name (covers exercises.name collision)
	return searchExercisesHandler(env, { query: name });
}

export function registerExerciseTools(server: McpServer, env: Bindings): void {
	server.registerTool(
		"search_exercises",
		{
			description:
				"登録済みの筋トレ種目を検索します。名前の部分一致、カテゴリで絞り込めます。新しい種目を登録する前に、既存の種目がないか必ず確認してください。",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe("名前・別名の部分一致検索キーワード"),
				category: categoryEnum.optional().describe("カテゴリでの絞り込み"),
			},
		},
		async (args) => {
			const result = await searchExercisesHandler(env, {
				query: args.query,
				category: args.category,
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	server.registerTool(
		"register_exercise",
		{
			description:
				"新しい筋トレ種目をマスタに登録します。重複を避けるため、必ず先に search_exercises で既存種目を確認してください。",
			inputSchema: {
				name: z.string().describe("種目の正規名称"),
				category: categoryEnum.default("strength").describe("カテゴリ"),
				equipment: z.string().optional().describe("使用器具"),
				target_muscles: z.string().optional().describe("対象部位"),
				aliases: z.array(z.string()).optional().describe("別名の配列"),
			},
		},
		async (args) => {
			try {
				const result = await registerExerciseHandler(env, {
					name: args.name,
					category: args.category,
					equipment: args.equipment,
					target_muscles: args.target_muscles,
					aliases: args.aliases,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				// Duplicate name/alias error from D1 UNIQUE constraint
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("UNIQUE constraint failed")) {
					const existing = await findConflictingExercises(
						env,
						args.name,
						args.aliases,
						message,
					);
					const conflictTarget = message.includes("exercise_aliases.alias")
						? "別名"
						: "種目名";
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `${conflictTarget}が既に登録されています`,
									existing_exercises: existing.exercises,
								}),
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: message }),
						},
					],
					isError: true,
				};
			}
		},
	);
}
