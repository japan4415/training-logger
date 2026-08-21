import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findExerciseByName, registerExercise } from "../../db/exercises.js";
import type { SetInput } from "../../db/records.js";
import {
	createSessionExercise,
	deleteSessionExercise,
	replaceSets,
	updateSessionExercise,
} from "../../db/records.js";
import {
	deleteSession,
	getOrCreateSession,
	getSessionByDate,
	updateSession,
} from "../../db/sessions.js";
import type { Bindings } from "../../env.js";

// ---- Shared types ----

/** MCP-layer set input (matches the tool schema naming) */
interface McpSetInput {
	reps?: number;
	weight?: number;
	weight_unit?: "kg" | "lbs" | "level";
	duration_minutes?: number;
	distance_km?: number;
	speed_min?: number;
	speed_max?: number;
	incline_percent?: number;
	angle_degrees?: number;
	is_planned?: boolean;
	notes?: string;
}

/** MCP-layer exercise input */
interface McpExerciseInput {
	name: string;
	equipment_note?: string;
	form_cues?: string;
	notes?: string;
	sets?: McpSetInput[];
}

// ---- Helpers ----

/**
 * Get today's date in Asia/Tokyo timezone as YYYY-MM-DD.
 * Cloudflare Workers run in UTC, so we must explicitly convert.
 */
export function getTodayDateJST(): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo",
	}).format(new Date());
}

/**
 * Convert MCP set input (tool schema naming) to DB set input.
 * Key mapping: weight -> weightValue, is_planned boolean -> kept as boolean
 * (the DB layer handles boolean->0/1 conversion internally)
 */
function toSetInput(mcpSet: McpSetInput): SetInput {
	return {
		reps: mcpSet.reps ?? null,
		weightValue: mcpSet.weight ?? null,
		weightUnit: mcpSet.weight_unit ?? null,
		durationMinutes: mcpSet.duration_minutes ?? null,
		distanceKm: mcpSet.distance_km ?? null,
		speedMin: mcpSet.speed_min ?? null,
		speedMax: mcpSet.speed_max ?? null,
		inclinePercent: mcpSet.incline_percent ?? null,
		angleDegrees: mcpSet.angle_degrees ?? null,
		isPlanned: mcpSet.is_planned ?? false,
		notes: mcpSet.notes ?? null,
	};
}

/**
 * Infer exercise category from set parameters.
 * If any set has duration_minutes, speed_min, or speed_max -> cardio
 * Otherwise -> strength
 */
function inferCategory(sets?: McpSetInput[]): "strength" | "cardio" {
	if (!sets || sets.length === 0) return "strength";
	for (const s of sets) {
		if (
			s.duration_minutes !== undefined ||
			s.speed_min !== undefined ||
			s.speed_max !== undefined
		) {
			return "cardio";
		}
	}
	return "strength";
}

/**
 * Resolve an exercise by name using 3-stage search.
 * If not found, auto-register with inferred category.
 */
async function resolveExercise(
	db: D1Database,
	name: string,
	sets?: McpSetInput[],
): Promise<{ exerciseId: number; autoRegistered: boolean }> {
	const existing = await findExerciseByName(db, name);
	if (existing) {
		return { exerciseId: existing.id, autoRegistered: false };
	}

	const category = inferCategory(sets);
	const { exercise } = await registerExercise(db, { name, category });
	return { exerciseId: exercise.id, autoRegistered: true };
}

// ---- Handler types ----

export interface LogWorkoutParams {
	date?: string;
	goal?: string;
	body_condition?: string;
	session_notes?: string;
	exercises: McpExerciseInput[];
}

export interface LogWorkoutResult {
	date: string;
	session_id: number;
	exercises_logged: number;
	sets_logged: number;
	auto_registered: string[];
}

export interface UpdateWorkoutParams {
	date: string;
	session_exercise_id?: number;
	exercise_name?: string;
	exercise_order?: number;
	equipment_note?: string;
	form_cues?: string;
	status?: "planned" | "completed" | "skipped";
	notes?: string;
	sets?: McpSetInput[];
}

export interface UpdateWorkoutResult {
	session_exercise_id: number;
	updated_fields: string[];
	sets_replaced: boolean;
}

export interface DeleteWorkoutParams {
	date: string;
	session_exercise_id?: number;
	exercise_name?: string;
	exercise_order?: number;
	delete_entire_session?: boolean;
}

export interface DeleteWorkoutResult {
	deleted: "session" | "exercise";
	date: string;
	exercise_name?: string;
}

// ---- Business logic handlers ----

export async function logWorkoutHandler(
	env: Bindings,
	params: LogWorkoutParams,
): Promise<LogWorkoutResult> {
	const db = env.DB;
	const date = params.date ?? getTodayDateJST();

	// Get or create session
	const { session, created } = await getOrCreateSession(db, {
		sessionDate: date,
		goal: params.goal ?? null,
		bodyCondition: params.body_condition ?? null,
		notes: params.session_notes ?? null,
	});

	// If session already existed, update metadata fields if provided
	if (!created) {
		await updateSession(db, session.id, {
			goal: params.goal,
			bodyCondition: params.body_condition,
			notes: params.session_notes,
		});
	}

	const autoRegistered: string[] = [];
	let totalSetsLogged = 0;

	for (const exerciseInput of params.exercises) {
		// Resolve exercise (3-stage search + auto-register)
		const { exerciseId, autoRegistered: wasAutoRegistered } =
			await resolveExercise(db, exerciseInput.name, exerciseInput.sets);

		if (wasAutoRegistered) {
			autoRegistered.push(exerciseInput.name);
		}

		// Create session_exercise
		const sessionExercise = await createSessionExercise(db, {
			sessionId: session.id,
			exerciseId,
			equipmentNote: exerciseInput.equipment_note ?? null,
			formCues: exerciseInput.form_cues ?? null,
			notes: exerciseInput.notes ?? null,
		});

		// Create sets if provided
		if (exerciseInput.sets && exerciseInput.sets.length > 0) {
			const setInputs = exerciseInput.sets.map(toSetInput);
			const createdSets = await replaceSets(db, sessionExercise.id, setInputs);
			totalSetsLogged += createdSets.length;
		}
	}

	return {
		date,
		session_id: session.id,
		exercises_logged: params.exercises.length,
		sets_logged: totalSetsLogged,
		auto_registered: autoRegistered,
	};
}

/**
 * Find a session_exercise by various identification methods.
 * Returns the session_exercise ID or throws a descriptive error.
 */
async function findSessionExercise(
	db: D1Database,
	sessionId: number,
	params: {
		sessionExerciseId?: number;
		exerciseName?: string;
		exerciseOrder?: number;
	},
): Promise<number> {
	// Direct ID specification
	if (params.sessionExerciseId !== undefined) {
		const row = await db
			.prepare(
				"SELECT id FROM session_exercises WHERE id = ? AND session_id = ?",
			)
			.bind(params.sessionExerciseId, sessionId)
			.first<{ id: number }>();
		if (!row) {
			throw new Error(
				`Session exercise ID ${params.sessionExerciseId} not found in this session`,
			);
		}
		return row.id;
	}

	// Name-based lookup
	if (!params.exerciseName) {
		throw new Error(
			"Either session_exercise_id or exercise_name must be specified",
		);
	}

	const exercise = await findExerciseByName(db, params.exerciseName);
	if (!exercise) {
		throw new Error(`Exercise "${params.exerciseName}" not found`);
	}

	const { results } = await db
		.prepare(
			`SELECT se.id, se.display_order FROM session_exercises se
			 WHERE se.session_id = ? AND se.exercise_id = ?
			 ORDER BY se.display_order`,
		)
		.bind(sessionId, exercise.id)
		.all<{ id: number; display_order: number }>();

	if (results.length === 0) {
		throw new Error(
			`Exercise "${params.exerciseName}" not found in session for this date`,
		);
	}

	if (results.length > 1 && params.exerciseOrder === undefined) {
		const orderList = results
			.map((r, i) => `${i + 1}: display_order=${r.display_order}`)
			.join(", ");
		throw new Error(
			`Multiple entries for "${params.exerciseName}" found (${results.length}). ` +
				`Specify exercise_order (1-based) to select one: ${orderList}`,
		);
	}

	const orderIndex = (params.exerciseOrder ?? 1) - 1;
	if (orderIndex < 0 || orderIndex >= results.length) {
		throw new Error(
			`exercise_order ${params.exerciseOrder} is out of range (1-${results.length})`,
		);
	}

	return results[orderIndex].id;
}

export async function updateWorkoutHandler(
	env: Bindings,
	params: UpdateWorkoutParams,
): Promise<UpdateWorkoutResult> {
	const db = env.DB;

	// Find session by date
	const session = await getSessionByDate(db, params.date);
	if (!session) {
		throw new Error(`No session found for date ${params.date}`);
	}

	// Find target session_exercise
	const sessionExerciseId = await findSessionExercise(db, session.id, {
		sessionExerciseId: params.session_exercise_id,
		exerciseName: params.exercise_name,
		exerciseOrder: params.exercise_order,
	});

	// Update session_exercise fields
	const updatedFields: string[] = [];
	const updateParams: {
		status?: "planned" | "completed" | "skipped";
		equipmentNote?: string | null;
		formCues?: string | null;
		notes?: string | null;
	} = {};

	if (params.equipment_note !== undefined) {
		updateParams.equipmentNote = params.equipment_note;
		updatedFields.push("equipment_note");
	}
	if (params.form_cues !== undefined) {
		updateParams.formCues = params.form_cues;
		updatedFields.push("form_cues");
	}
	if (params.status !== undefined) {
		updateParams.status = params.status;
		updatedFields.push("status");
	}
	if (params.notes !== undefined) {
		updateParams.notes = params.notes;
		updatedFields.push("notes");
	}

	if (updatedFields.length > 0) {
		await updateSessionExercise(db, sessionExerciseId, updateParams);
	}

	// Replace sets if provided
	let setsReplaced = false;
	if (params.sets !== undefined) {
		const setInputs = params.sets.map(toSetInput);
		await replaceSets(db, sessionExerciseId, setInputs);
		setsReplaced = true;
	}

	return {
		session_exercise_id: sessionExerciseId,
		updated_fields: updatedFields,
		sets_replaced: setsReplaced,
	};
}

export async function deleteWorkoutHandler(
	env: Bindings,
	params: DeleteWorkoutParams,
): Promise<DeleteWorkoutResult> {
	const db = env.DB;

	// Find session by date
	const session = await getSessionByDate(db, params.date);
	if (!session) {
		throw new Error(`No session found for date ${params.date}`);
	}

	// Delete entire session
	if (params.delete_entire_session) {
		await deleteSession(db, session.id);
		return { deleted: "session", date: params.date };
	}

	// Delete specific exercise
	const sessionExerciseId = await findSessionExercise(db, session.id, {
		sessionExerciseId: params.session_exercise_id,
		exerciseName: params.exercise_name,
		exerciseOrder: params.exercise_order,
	});

	await deleteSessionExercise(db, sessionExerciseId);

	return {
		deleted: "exercise",
		date: params.date,
		exercise_name: params.exercise_name,
	};
}

// ---- Zod schemas for MCP tool registration ----

const SetSchema = {
	reps: z.number().int().optional().describe("回数"),
	weight: z.number().optional().describe("重量またはレベル値"),
	weight_unit: z.enum(["kg", "lbs", "level"]).optional().describe("重量の単位"),
	duration_minutes: z.number().optional().describe("時間 (分)"),
	distance_km: z.number().optional().describe("距離 (km)"),
	speed_min: z.number().optional().describe("速度下限 (km/h)"),
	speed_max: z.number().optional().describe("速度上限 (km/h)"),
	incline_percent: z.number().optional().describe("傾斜 (%)"),
	angle_degrees: z.number().optional().describe("角度 (度)"),
	is_planned: z
		.boolean()
		.optional()
		.default(false)
		.describe("true=計画, false=実績"),
	notes: z.string().optional().describe("セットのメモ"),
};

const ExerciseInputSchema = {
	name: z.string().describe("種目名 (正規名または別名)"),
	equipment_note: z.string().optional().describe("この実施での器具メモ"),
	form_cues: z
		.string()
		.optional()
		.describe("フォームキュー (改行区切りで複数指定可)"),
	notes: z.string().optional().describe("メモ"),
	sets: z.array(z.object(SetSchema)).optional().describe("セット情報の配列"),
};

// ---- MCP tool registration ----

export function registerWorkoutTools(server: McpServer, env: Bindings): void {
	// log_workout
	server.registerTool(
		"log_workout",
		{
			description:
				"1日分のワークアウトを記録します。複数の種目とセット情報をまとめて登録できます。同じ日に既にセッションがある場合は種目を追加します。種目名は正式名称・別名のどちらでも指定でき、未登録の種目は自動登録されます。",
			inputSchema: {
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("セッション日付 (YYYY-MM-DD)。省略時は今日 (Asia/Tokyo)"),
				goal: z.string().optional().describe("目的 (例: ダイエット)"),
				body_condition: z.string().optional().describe("体調・怪我メモ"),
				session_notes: z.string().optional().describe("セッション全体のメモ"),
				exercises: z
					.array(z.object(ExerciseInputSchema))
					.min(1)
					.describe("種目とセット情報の配列"),
			},
		},
		async (args) => {
			try {
				const result = await logWorkoutHandler(env, args);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : "Unknown error",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// update_workout
	server.registerTool(
		"update_workout",
		{
			description:
				"ワークアウトの記録を修正します。日付と種目を指定して、器具メモ・フォームキュー・ステータス・セット情報を更新できます。",
			inputSchema: {
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("セッション日付 (YYYY-MM-DD)"),
				session_exercise_id: z
					.number()
					.int()
					.optional()
					.describe("種目実施 ID (直接指定する場合)"),
				exercise_name: z
					.string()
					.optional()
					.describe("種目名で対象を指定する場合"),
				exercise_order: z
					.number()
					.int()
					.optional()
					.describe("同日に同名種目が複数ある場合の何番目か (1-based)"),
				equipment_note: z.string().optional().describe("器具メモの更新値"),
				form_cues: z.string().optional().describe("フォームキューの更新値"),
				status: z
					.enum(["planned", "completed", "skipped"])
					.optional()
					.describe("ステータスの更新値"),
				notes: z.string().optional().describe("メモの更新値"),
				sets: z
					.array(z.object(SetSchema))
					.optional()
					.describe(
						"セット情報の更新値。指定時は既存セットを全削除して差し替え",
					),
			},
		},
		async (args) => {
			try {
				const result = await updateWorkoutHandler(env, args);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : "Unknown error",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// delete_workout
	server.registerTool(
		"delete_workout",
		{
			description:
				"ワークアウトの記録を削除します。特定の種目だけを削除するか、セッション全体を削除できます。",
			inputSchema: {
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("セッション日付 (YYYY-MM-DD)"),
				session_exercise_id: z
					.number()
					.int()
					.optional()
					.describe("種目実施 ID (直接指定する場合)"),
				exercise_name: z
					.string()
					.optional()
					.describe("種目名で対象を指定する場合"),
				exercise_order: z
					.number()
					.int()
					.optional()
					.describe("同日に同名種目が複数ある場合の何番目か (1-based)"),
				delete_entire_session: z
					.boolean()
					.optional()
					.default(false)
					.describe("true の場合、セッション全体を削除する"),
			},
		},
		async (args) => {
			try {
				const result = await deleteWorkoutHandler(env, args);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : "Unknown error",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
