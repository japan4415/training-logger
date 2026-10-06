import { assertSessionOwned } from "./sessions.js";
import type { SessionExerciseRow, SetRow } from "./types.js";

/** Input for creating or replacing a set */
export interface SetInput {
	isPlanned?: boolean;
	reps?: number | null;
	weightValue?: number | null;
	weightUnit?: "kg" | "lbs" | "level" | null;
	durationMinutes?: number | null;
	distanceKm?: number | null;
	speedMin?: number | null;
	speedMax?: number | null;
	inclinePercent?: number | null;
	angleDegrees?: number | null;
	notes?: string | null;
}

/**
 * Create a session exercise with auto-generated display_order.
 * display_order is assigned as max(display_order) + 1 within the session.
 * The parent session must belong to the given user.
 */
export async function createSessionExercise(
	db: D1Database,
	userId: number,
	params: {
		sessionId: number;
		exerciseId: number;
		status?: SessionExerciseRow["status"];
		equipmentNote?: string | null;
		formCues?: string | null;
		notes?: string | null;
	},
): Promise<SessionExerciseRow> {
	const {
		sessionId,
		exerciseId,
		status = "completed",
		equipmentNote = null,
		formCues = null,
		notes = null,
	} = params;

	if (!(await assertSessionOwned(db, userId, sessionId))) {
		throw new Error("Session not found");
	}

	// Get next display_order for this session
	const maxOrder = await db
		.prepare(
			"SELECT COALESCE(MAX(display_order), 0) as max_order FROM session_exercises WHERE session_id = ?",
		)
		.bind(sessionId)
		.first<{ max_order: number }>();
	const displayOrder = (maxOrder?.max_order ?? 0) + 1;

	const result = await db
		.prepare(
			`INSERT INTO session_exercises (session_id, exercise_id, display_order, status, equipment_note, form_cues, notes)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			sessionId,
			exerciseId,
			displayOrder,
			status,
			equipmentNote,
			formCues,
			notes,
		)
		.run();

	const inserted = await db
		.prepare("SELECT * FROM session_exercises WHERE id = ?")
		.bind(result.meta.last_row_id)
		.first<SessionExerciseRow>();
	if (!inserted) throw new Error("Failed to retrieve created session exercise");

	return inserted;
}

/**
 * Update a session exercise owned by the given user. Only specified fields are updated.
 * Another user's row is treated as non-existent and returns null.
 */
export async function updateSessionExercise(
	db: D1Database,
	userId: number,
	id: number,
	params: {
		status?: SessionExerciseRow["status"];
		equipmentNote?: string | null;
		formCues?: string | null;
		notes?: string | null;
	},
): Promise<SessionExerciseRow | null> {
	// Fetch existing row (scoped to the owner) to merge with updates
	const existing = await db
		.prepare(
			`SELECT se.* FROM session_exercises se
			 JOIN workout_sessions ws ON se.session_id = ws.id
			 WHERE se.id = ? AND ws.user_id = ?`,
		)
		.bind(id, userId)
		.first<SessionExerciseRow>();
	if (!existing) return null;

	const status = params.status ?? existing.status;
	const equipmentNote =
		params.equipmentNote !== undefined
			? params.equipmentNote
			: existing.equipment_note;
	const formCues =
		params.formCues !== undefined ? params.formCues : existing.form_cues;
	const notes = params.notes !== undefined ? params.notes : existing.notes;

	await db
		.prepare(
			`UPDATE session_exercises
			 SET status = ?, equipment_note = ?, form_cues = ?, notes = ?
			 WHERE id = ?
			   AND session_id IN (SELECT id FROM workout_sessions WHERE user_id = ?)`,
		)
		.bind(status, equipmentNote, formCues, notes, id, userId)
		.run();

	return db
		.prepare(
			`SELECT se.* FROM session_exercises se
			 JOIN workout_sessions ws ON se.session_id = ws.id
			 WHERE se.id = ? AND ws.user_id = ?`,
		)
		.bind(id, userId)
		.first<SessionExerciseRow>();
}

/**
 * Delete a session exercise by ID owned by the given user. Returns true if a row
 * was deleted. CASCADE deletes associated sets.
 */
export async function deleteSessionExercise(
	db: D1Database,
	userId: number,
	id: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM session_exercises
			 WHERE id = ?
			   AND session_id IN (SELECT id FROM workout_sessions WHERE user_id = ?)`,
		)
		.bind(id, userId)
		.run();
	return result.meta.changes > 0;
}

/**
 * True when the session exercise exists and its parent session belongs to the user.
 */
async function sessionExerciseBelongsToUser(
	db: D1Database,
	userId: number,
	sessionExerciseId: number,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM session_exercises se
			 JOIN workout_sessions ws ON se.session_id = ws.id
			 WHERE se.id = ? AND ws.user_id = ?`,
		)
		.bind(sessionExerciseId, userId)
		.first<{ ok: number }>();
	return row !== null;
}

/**
 * Create a single set with explicit set_order.
 * The parent session exercise must belong to the given user.
 */
export async function createSet(
	db: D1Database,
	userId: number,
	params: {
		sessionExerciseId: number;
		setOrder: number;
		isPlanned?: boolean;
		reps?: number | null;
		weightValue?: number | null;
		weightUnit?: "kg" | "lbs" | "level" | null;
		durationMinutes?: number | null;
		distanceKm?: number | null;
		speedMin?: number | null;
		speedMax?: number | null;
		inclinePercent?: number | null;
		angleDegrees?: number | null;
		notes?: string | null;
	},
): Promise<SetRow> {
	const {
		sessionExerciseId,
		setOrder,
		isPlanned = false,
		reps = null,
		weightValue = null,
		weightUnit = null,
		durationMinutes = null,
		distanceKm = null,
		speedMin = null,
		speedMax = null,
		inclinePercent = null,
		angleDegrees = null,
		notes = null,
	} = params;

	if (!(await sessionExerciseBelongsToUser(db, userId, sessionExerciseId))) {
		throw new Error("Session exercise not found");
	}

	const result = await db
		.prepare(
			`INSERT INTO sets (session_exercise_id, set_order, is_planned,
			 reps, weight_value, weight_unit,
			 duration_minutes, distance_km, speed_min, speed_max,
			 incline_percent, angle_degrees, notes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			sessionExerciseId,
			setOrder,
			isPlanned ? 1 : 0,
			reps,
			weightValue,
			weightUnit,
			durationMinutes,
			distanceKm,
			speedMin,
			speedMax,
			inclinePercent,
			angleDegrees,
			notes,
		)
		.run();

	const inserted = await db
		.prepare("SELECT * FROM sets WHERE id = ?")
		.bind(result.meta.last_row_id)
		.first<SetRow>();
	if (!inserted) throw new Error("Failed to retrieve created set");

	return inserted;
}

/**
 * Replace all sets for a session exercise (full delete + re-create).
 * set_order is auto-assigned per is_planned group (planned and actual each start from 1).
 * The parent session exercise must belong to the given user.
 *
 * DELETE and all INSERTs run inside a single db.batch() transaction.
 * If any INSERT fails, the entire batch (including the DELETE) is rolled back,
 * preventing the data loss scenario where sets are deleted but not re-created.
 */
export async function replaceSets(
	db: D1Database,
	userId: number,
	sessionExerciseId: number,
	sets: SetInput[],
): Promise<SetRow[]> {
	if (!(await sessionExerciseBelongsToUser(db, userId, sessionExerciseId))) {
		throw new Error("Session exercise not found");
	}

	// Build all statements for a single transactional batch
	const statements: D1PreparedStatement[] = [
		db
			.prepare("DELETE FROM sets WHERE session_exercise_id = ?")
			.bind(sessionExerciseId),
	];

	// Track set_order independently for each is_planned value
	const orderCounters = new Map<number, number>();

	for (const set of sets) {
		const isPlanned = set.isPlanned ? 1 : 0;
		const currentOrder = orderCounters.get(isPlanned) ?? 0;
		const nextOrder = currentOrder + 1;
		orderCounters.set(isPlanned, nextOrder);

		statements.push(
			db
				.prepare(
					`INSERT INTO sets (session_exercise_id, set_order, is_planned,
					 reps, weight_value, weight_unit,
					 duration_minutes, distance_km, speed_min, speed_max,
					 incline_percent, angle_degrees, notes)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					sessionExerciseId,
					nextOrder,
					isPlanned,
					set.reps ?? null,
					set.weightValue ?? null,
					set.weightUnit ?? null,
					set.durationMinutes ?? null,
					set.distanceKm ?? null,
					set.speedMin ?? null,
					set.speedMax ?? null,
					set.inclinePercent ?? null,
					set.angleDegrees ?? null,
					set.notes ?? null,
				),
		);
	}

	await db.batch(statements);

	// Return all inserted sets ordered by is_planned, set_order
	const { results } = await db
		.prepare(
			"SELECT * FROM sets WHERE session_exercise_id = ? ORDER BY is_planned, set_order",
		)
		.bind(sessionExerciseId)
		.all<SetRow>();

	return results;
}

/**
 * Delete all sets for a session exercise owned by the given user.
 */
export async function deleteSetsBySessionExercise(
	db: D1Database,
	userId: number,
	sessionExerciseId: number,
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM sets
			 WHERE session_exercise_id = ?
			   AND session_exercise_id IN (
			     SELECT se.id FROM session_exercises se
			     JOIN workout_sessions ws ON se.session_id = ws.id
			     WHERE ws.user_id = ?
			   )`,
		)
		.bind(sessionExerciseId, userId)
		.run();
}
