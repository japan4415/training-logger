import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	registerExercise,
	searchExercises,
	setExerciseAtlasMuscles,
} from "../../db/exercises.js";
import {
	ATLAS_MUSCLES,
	type AtlasAssignment,
	parseAtlasAssignment,
} from "../../domain/atlas.js";
import type { Bindings } from "../../env.js";

// ---- Response types ----

export interface SearchExercisesResult {
	exercises: Array<{
		id: number;
		name: string;
		category: string;
		equipment: string | null;
		target_muscles: string | null;
		atlas_muscles: AtlasAssignment | null;
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
		atlas_muscles: AtlasAssignment | null;
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
	atlas_muscles?: AtlasAssignment | null;
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
			atlas_muscles: parseAtlasAssignment(r.exercise.atlas_muscles),
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
		atlas_muscles: params.atlas_muscles,
		aliases: params.aliases,
	});

	return {
		exercise: {
			id: result.exercise.id,
			name: result.exercise.name,
			category: result.exercise.category,
			equipment: result.exercise.equipment,
			target_muscles: result.exercise.target_muscles,
			atlas_muscles: parseAtlasAssignment(result.exercise.atlas_muscles),
			aliases: result.aliases.map((a) => a.alias),
		},
	};
}

export function listAtlasMusclesHandler(params: { query?: string } = {}) {
	const query = params.query?.trim().toLocaleLowerCase();
	return {
		muscles: ATLAS_MUSCLES.filter(
			(muscle) =>
				!query ||
				[muscle.id, muscle.name, muscle.label, muscle.groupLabel].some(
					(value) => value.toLocaleLowerCase().includes(query),
				),
		),
	};
}

export async function setExerciseMusclesHandler(
	env: Bindings,
	params: { exercise_id: number; atlas_muscles: AtlasAssignment | null },
) {
	const exercise = await setExerciseAtlasMuscles(
		env.DB,
		params.exercise_id,
		params.atlas_muscles,
	);
	return {
		exercise: {
			...exercise,
			atlas_muscles: parseAtlasAssignment(exercise.atlas_muscles),
		},
	};
}

// ---- MCP tool registration ----

const atlasAssignmentSchema = z
	.object({
		primary: z
			.array(z.string().min(1).max(160))
			.max(200)
			.describe("主働筋の正確なAtlas ID配列。list_atlas_musclesで確認"),
		secondary: z
			.array(z.string().min(1).max(160))
			.max(200)
			.describe("補助筋のAtlas ID配列"),
		unavailable: z
			.array(z.string().trim().min(1).max(100))
			.max(50)
			.describe("Atlasにモデルのない筋肉・部位名"),
	})
	.strict();

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
		"list_atlas_muscles",
		{
			description:
				"割当可能なHuman Atlasの筋肉ID・英語名・日本語名・部位を検索します。筋肉の登録・更新前にIDを確認してください。",
			annotations: { readOnlyHint: true },
			inputSchema: {
				query: z
					.string()
					.max(200)
					.optional()
					.describe("筋肉ID・英語名・日本語名・部位の部分一致"),
			},
		},
		async (args) => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(listAtlasMusclesHandler(args)),
				},
			],
		}),
	);

	server.registerTool(
		"set_exercise_muscles",
		{
			description:
				"登録済み種目の主働筋・補助筋をAtlasの正確なIDで設定します。既存割当を置換します。nullで従来の部位名による表示へ戻します。",
			inputSchema: {
				exercise_id: z.number().int().positive().describe("種目ID"),
				atlas_muscles: atlasAssignmentSchema.nullable(),
			},
		},
		async (args) => {
			try {
				const result = await setExerciseMusclesHandler(env, args);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

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
				atlas_muscles: atlasAssignmentSchema
					.nullable()
					.optional()
					.describe(
						"Atlas筋肉の割当。省略時は既知の種目名から設定、nullは従来の部位名で表示",
					),
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
					atlas_muscles: args.atlas_muscles,
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
