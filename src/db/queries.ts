import { findExerciseByName } from "./exercises.js";
import type {
	ExerciseRow,
	SessionExerciseRow,
	SetRow,
	WorkoutSessionRow,
} from "./types.js";

/** Session exercise detail including exercise info and sets */
export interface SessionExerciseDetail {
	sessionExercise: SessionExerciseRow;
	exercise: ExerciseRow;
	sets: SetRow[];
}

/** Full session detail with all exercises and sets */
export interface SessionDetail {
	session: WorkoutSessionRow;
	exercises: SessionExerciseDetail[];
}

/** Exercise statistics */
export interface ExerciseStatsResult {
	exerciseId: number;
	exerciseName: string;
	totalSessions: number;
	maxWeight: {
		value: number;
		unit: string;
		date: string;
	} | null;
	sessionSummaries: Array<{
		sessionDate: string;
		totalReps: number;
		totalSets: number;
	}>;
}

/** Parameters for history query */
export interface HistoryParams {
	exerciseName?: string;
	dateFrom?: string;
	dateTo?: string;
	lastNSessions?: number;
	includeSets?: boolean;
}

/**
 * Get workout history with filters.
 * When exerciseName is specified, only matching exercises are included in each session.
 */
export async function getHistory(
	db: D1Database,
	params: HistoryParams = {},
): Promise<SessionDetail[]> {
	const {
		exerciseName,
		dateFrom,
		dateTo,
		lastNSessions,
		includeSets = true,
	} = params;

	// Resolve exercise name to ID if specified
	let exerciseId: number | undefined;
	if (exerciseName) {
		const exercise = await findExerciseByName(db, exerciseName);
		if (!exercise) return [];
		exerciseId = exercise.id;
	}

	// Build session query dynamically (only structural parts, values are bound)
	const conditions: string[] = [];
	const bindings: (string | number)[] = [];

	let sql = "SELECT DISTINCT ws.* FROM workout_sessions ws";

	if (exerciseId !== undefined) {
		sql += " JOIN session_exercises se ON ws.id = se.session_id";
		conditions.push("se.exercise_id = ?");
		bindings.push(exerciseId);
	}

	if (dateFrom) {
		conditions.push("ws.session_date >= ?");
		bindings.push(dateFrom);
	}

	if (dateTo) {
		conditions.push("ws.session_date <= ?");
		bindings.push(dateTo);
	}

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	sql += " ORDER BY ws.session_date DESC";

	if (lastNSessions !== undefined) {
		sql += " LIMIT ?";
		bindings.push(lastNSessions);
	}

	const stmt =
		bindings.length > 0 ? db.prepare(sql).bind(...bindings) : db.prepare(sql);
	const { results: sessions } = await stmt.all<WorkoutSessionRow>();

	// Build detail for each session
	const details: SessionDetail[] = [];
	for (const session of sessions) {
		const detail = await buildSessionDetail(
			db,
			session,
			includeSets,
			exerciseId,
		);
		details.push(detail);
	}

	return details;
}

/**
 * Get full details of a single session (all exercises and sets).
 */
export async function getSessionDetail(
	db: D1Database,
	sessionId: number,
): Promise<SessionDetail | null> {
	const session = await db
		.prepare("SELECT * FROM workout_sessions WHERE id = ?")
		.bind(sessionId)
		.first<WorkoutSessionRow>();

	if (!session) return null;

	return buildSessionDetail(db, session, true);
}

/**
 * Get statistics for a specific exercise.
 * Only considers actual performance (is_planned = 0).
 *
 * Note on maxWeight: The comparison uses raw weight_value regardless of unit.
 * kg/lbs/level values are not converted, following the design decision in
 * docs/database.md to store units as-is without conversion. Users typically
 * use a single unit consistently per exercise, so this is adequate.
 *
 * Note on totalSessions vs sessionSummaries: totalSessions counts all sessions
 * containing the exercise (including planned-only sessions), while sessionSummaries
 * only includes sessions that have actual sets (is_planned = 0) with the JOIN to
 * the sets table. A planned-only session will increment totalSessions but will not
 * appear in sessionSummaries.
 */
export async function getExerciseStats(
	db: D1Database,
	exerciseId: number,
): Promise<ExerciseStatsResult | null> {
	const exercise = await db
		.prepare("SELECT * FROM exercises WHERE id = ?")
		.bind(exerciseId)
		.first<ExerciseRow>();

	if (!exercise) return null;

	// Total sessions containing this exercise
	const totalResult = await db
		.prepare(
			`SELECT COUNT(DISTINCT se.session_id) as total
			 FROM session_exercises se
			 WHERE se.exercise_id = ?`,
		)
		.bind(exerciseId)
		.first<{ total: number }>();
	const totalSessions = totalResult?.total ?? 0;

	// Max weight (actual sets only)
	const maxWeightRow = await db
		.prepare(
			`SELECT s.weight_value, s.weight_unit, ws.session_date
			 FROM sets s
			 JOIN session_exercises se ON s.session_exercise_id = se.id
			 JOIN workout_sessions ws ON se.session_id = ws.id
			 WHERE se.exercise_id = ?
			   AND s.weight_value IS NOT NULL
			   AND s.is_planned = 0
			 ORDER BY s.weight_value DESC
			 LIMIT 1`,
		)
		.bind(exerciseId)
		.first<{
			weight_value: number;
			weight_unit: string;
			session_date: string;
		}>();

	const maxWeight = maxWeightRow
		? {
				value: maxWeightRow.weight_value,
				unit: maxWeightRow.weight_unit,
				date: maxWeightRow.session_date,
			}
		: null;

	// Per-session summaries (actual sets only)
	const { results: summaries } = await db
		.prepare(
			`SELECT ws.session_date,
			        COALESCE(SUM(s.reps), 0) as total_reps,
			        COUNT(s.id) as total_sets
			 FROM session_exercises se
			 JOIN workout_sessions ws ON se.session_id = ws.id
			 JOIN sets s ON se.id = s.session_exercise_id
			 WHERE se.exercise_id = ?
			   AND s.is_planned = 0
			 GROUP BY ws.id
			 ORDER BY ws.session_date DESC`,
		)
		.bind(exerciseId)
		.all<{ session_date: string; total_reps: number; total_sets: number }>();

	return {
		exerciseId: exercise.id,
		exerciseName: exercise.name,
		totalSessions,
		maxWeight,
		sessionSummaries: summaries.map((s) => ({
			sessionDate: s.session_date,
			totalReps: s.total_reps,
			totalSets: s.total_sets,
		})),
	};
}

// ---- Internal helpers ----

/** Joined row type for session_exercises + exercises query */
interface JoinedSessionExerciseRow {
	id: number;
	session_id: number;
	exercise_id: number;
	display_order: number;
	status: "planned" | "completed" | "skipped";
	equipment_note: string | null;
	form_cues: string | null;
	notes: string | null;
	created_at: string;
	ex_id: number;
	ex_name: string;
	ex_category: "strength" | "cardio" | "flexibility" | "other";
	ex_equipment: string | null;
	ex_target_muscles: string | null;
	ex_notes: string | null;
	ex_created_at: string;
	ex_updated_at: string;
}

async function buildSessionDetail(
	db: D1Database,
	session: WorkoutSessionRow,
	includeSets: boolean,
	exerciseIdFilter?: number,
): Promise<SessionDetail> {
	// Get session exercises joined with exercise info
	let seSql = `SELECT se.*,
	             e.id as ex_id, e.name as ex_name, e.category as ex_category,
	             e.equipment as ex_equipment, e.target_muscles as ex_target_muscles,
	             e.notes as ex_notes, e.created_at as ex_created_at, e.updated_at as ex_updated_at
	             FROM session_exercises se
	             JOIN exercises e ON se.exercise_id = e.id
	             WHERE se.session_id = ?`;
	const seBindings: number[] = [session.id];

	if (exerciseIdFilter !== undefined) {
		seSql += " AND se.exercise_id = ?";
		seBindings.push(exerciseIdFilter);
	}

	seSql += " ORDER BY se.display_order";

	const { results: seRows } = await db
		.prepare(seSql)
		.bind(...seBindings)
		.all<JoinedSessionExerciseRow>();

	const exercises: SessionExerciseDetail[] = [];
	for (const row of seRows) {
		const sessionExercise: SessionExerciseRow = {
			id: row.id,
			session_id: row.session_id,
			exercise_id: row.exercise_id,
			display_order: row.display_order,
			status: row.status,
			equipment_note: row.equipment_note,
			form_cues: row.form_cues,
			notes: row.notes,
			created_at: row.created_at,
		};

		const exercise: ExerciseRow = {
			id: row.ex_id,
			name: row.ex_name,
			category: row.ex_category,
			equipment: row.ex_equipment,
			target_muscles: row.ex_target_muscles,
			notes: row.ex_notes,
			created_at: row.ex_created_at,
			updated_at: row.ex_updated_at,
		};

		let sets: SetRow[] = [];
		if (includeSets) {
			const { results: setResults } = await db
				.prepare(
					"SELECT * FROM sets WHERE session_exercise_id = ? ORDER BY is_planned, set_order",
				)
				.bind(row.id)
				.all<SetRow>();
			sets = setResults;
		}

		exercises.push({ sessionExercise, exercise, sets });
	}

	return { session, exercises };
}
