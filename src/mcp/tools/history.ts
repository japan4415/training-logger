import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getHistory, type SessionDetail } from "../../db/queries.js";
import type { Bindings } from "../../env.js";

/** Parameters for the get_history MCP tool */
export interface GetHistoryParams {
	exerciseName?: string;
	dateFrom?: string;
	dateTo?: string;
	lastNSessions?: number;
	includeSets?: boolean;
}

/** Formatted session for the MCP response */
interface FormattedSession {
	date: string;
	goal: string | null;
	body_condition: string | null;
	notes: string | null;
	exercises: FormattedExercise[];
}

/** Formatted exercise within a session */
interface FormattedExercise {
	name: string;
	category: string;
	status: string;
	equipment_note: string | null;
	form_cues: string | null;
	notes: string | null;
	sets: FormattedSet[];
}

/** Formatted set within an exercise */
interface FormattedSet {
	set_order: number;
	is_planned: boolean;
	reps: number | null;
	weight: number | null;
	weight_unit: string | null;
	duration_minutes: number | null;
	distance_km: number | null;
	speed_min: number | null;
	speed_max: number | null;
	incline_percent: number | null;
	angle_degrees: number | null;
	notes: string | null;
}

/** Result type for getHistoryHandler */
export interface GetHistoryResult {
	sessions: FormattedSession[];
}

/**
 * Format raw SessionDetail[] into a clean MCP response structure.
 */
function formatSessions(details: SessionDetail[]): FormattedSession[] {
	return details.map((detail) => ({
		date: detail.session.session_date,
		goal: detail.session.goal,
		body_condition: detail.session.body_condition,
		notes: detail.session.notes,
		exercises: detail.exercises.map((ex) => ({
			name: ex.exercise.name,
			category: ex.exercise.category,
			status: ex.sessionExercise.status,
			equipment_note: ex.sessionExercise.equipment_note,
			form_cues: ex.sessionExercise.form_cues,
			notes: ex.sessionExercise.notes,
			sets: ex.sets.map((s) => ({
				set_order: s.set_order,
				is_planned: s.is_planned === 1,
				reps: s.reps,
				weight: s.weight_value,
				weight_unit: s.weight_unit,
				duration_minutes: s.duration_minutes,
				distance_km: s.distance_km,
				speed_min: s.speed_min,
				speed_max: s.speed_max,
				incline_percent: s.incline_percent,
				angle_degrees: s.angle_degrees,
				notes: s.notes,
			})),
		})),
	}));
}

const DEFAULT_LAST_N_SESSIONS = 5;

/**
 * Business logic handler for get_history.
 * Delegates to the DB layer and formats the response.
 */
export async function getHistoryHandler(
	env: Bindings,
	params: GetHistoryParams,
): Promise<GetHistoryResult> {
	const details = await getHistory(env.DB, {
		exerciseName: params.exerciseName,
		dateFrom: params.dateFrom,
		dateTo: params.dateTo,
		lastNSessions: params.lastNSessions ?? DEFAULT_LAST_N_SESSIONS,
		includeSets: params.includeSets ?? true,
	});

	return { sessions: formatSessions(details) };
}

/**
 * Register the get_history tool on an McpServer instance.
 */
export function registerHistoryTools(server: McpServer, env: Bindings): void {
	server.registerTool(
		"get_history",
		{
			description:
				"過去のワークアウト履歴を照会します。特定種目の前回の重量・回数の確認、期間指定の一覧、最近のセッション一覧に使えます。",
			inputSchema: {
				exercise_name: z
					.string()
					.optional()
					.describe("種目名で絞り込み (正規名・別名どちらでも可)"),
				date_from: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("検索開始日 (YYYY-MM-DD)"),
				date_to: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("検索終了日 (YYYY-MM-DD)"),
				last_n_sessions: z
					.number()
					.int()
					.optional()
					.default(DEFAULT_LAST_N_SESSIONS)
					.describe("取得するセッション数の上限"),
				include_sets: z
					.boolean()
					.optional()
					.default(true)
					.describe("セット詳細を含めるか"),
			},
		},
		async (args) => {
			const result = await getHistoryHandler(env, {
				exerciseName: args.exercise_name,
				dateFrom: args.date_from,
				dateTo: args.date_to,
				lastNSessions: args.last_n_sessions,
				includeSets: args.include_sets,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);
}
