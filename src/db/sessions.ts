import type { WorkoutSessionRow } from "./types.js";

/**
 * Get or create a session by date.
 * If a session already exists for the given date, returns it without modification.
 * If not, creates a new session.
 *
 * Note: The SELECT-then-INSERT pattern is not atomic. If concurrent requests target
 * the same date, both may pass the SELECT check and one INSERT will fail with a
 * UNIQUE constraint error on session_date. This is acceptable for a single-user
 * personal app where concurrent writes to the same date are not expected.
 */
export async function getOrCreateSession(
	db: D1Database,
	params: {
		sessionDate: string;
		goal?: string | null;
		bodyCondition?: string | null;
		notes?: string | null;
	},
): Promise<{ session: WorkoutSessionRow; created: boolean }> {
	const {
		sessionDate,
		goal = null,
		bodyCondition = null,
		notes = null,
	} = params;

	// Try to find existing session
	const existing = await getSessionByDate(db, sessionDate);
	if (existing) {
		return { session: existing, created: false };
	}

	// Create new session
	const result = await db
		.prepare(
			`INSERT INTO workout_sessions (session_date, goal, body_condition, notes)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(sessionDate, goal, bodyCondition, notes)
		.run();

	const session = await getSessionById(db, result.meta.last_row_id);
	if (!session) throw new Error("Failed to retrieve created session");

	return { session, created: true };
}

/**
 * Get session by ID.
 */
export async function getSessionById(
	db: D1Database,
	id: number,
): Promise<WorkoutSessionRow | null> {
	return db
		.prepare("SELECT * FROM workout_sessions WHERE id = ?")
		.bind(id)
		.first<WorkoutSessionRow>();
}

/**
 * Get session by date (YYYY-MM-DD).
 */
export async function getSessionByDate(
	db: D1Database,
	date: string,
): Promise<WorkoutSessionRow | null> {
	return db
		.prepare("SELECT * FROM workout_sessions WHERE session_date = ?")
		.bind(date)
		.first<WorkoutSessionRow>();
}

/**
 * Get sessions for a specific month.
 */
export async function getSessionsByMonth(
	db: D1Database,
	year: number,
	month: number,
): Promise<WorkoutSessionRow[]> {
	const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
	const endMonth = month === 12 ? 1 : month + 1;
	const endYear = month === 12 ? year + 1 : year;
	const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

	const { results } = await db
		.prepare(
			`SELECT * FROM workout_sessions
			 WHERE session_date >= ? AND session_date < ?
			 ORDER BY session_date`,
		)
		.bind(startDate, endDate)
		.all<WorkoutSessionRow>();

	return results;
}

/**
 * Get the most recent N sessions.
 */
export async function getRecentSessions(
	db: D1Database,
	limit: number,
): Promise<WorkoutSessionRow[]> {
	const { results } = await db
		.prepare(
			"SELECT * FROM workout_sessions ORDER BY session_date DESC LIMIT ?",
		)
		.bind(limit)
		.all<WorkoutSessionRow>();
	return results;
}

/**
 * Update session metadata fields. Only specified (non-undefined) fields are updated.
 * If no fields are provided, this is a no-op.
 */
export async function updateSession(
	db: D1Database,
	id: number,
	params: { goal?: string; bodyCondition?: string; notes?: string },
): Promise<void> {
	const updates: string[] = [];
	const values: (string | number)[] = [];

	if (params.goal !== undefined) {
		updates.push("goal = ?");
		values.push(params.goal);
	}
	if (params.bodyCondition !== undefined) {
		updates.push("body_condition = ?");
		values.push(params.bodyCondition);
	}
	if (params.notes !== undefined) {
		updates.push("notes = ?");
		values.push(params.notes);
	}

	if (updates.length === 0) return;

	values.push(id);
	await db
		.prepare(`UPDATE workout_sessions SET ${updates.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();
}

/**
 * Delete a session by ID. Returns true if a row was deleted.
 * CASCADE deletes session_exercises and sets.
 */
export async function deleteSession(
	db: D1Database,
	id: number,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM workout_sessions WHERE id = ?")
		.bind(id)
		.run();
	return result.meta.changes > 0;
}
