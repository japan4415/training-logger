import type { Bindings } from "../env.js";
import {
	deleteSessionPhotosForSession,
	sweepSessionPhotoObjects,
} from "./session-photos.js";
import type { WorkoutSessionRow } from "./types.js";

/**
 * Get or create a session by date for the given user.
 * If a session already exists for the given (user, date), returns it without modification.
 * If not, creates a new session.
 *
 * Note: The SELECT-then-INSERT pattern is not atomic. If concurrent requests target
 * the same (user, date), both may pass the SELECT check and one INSERT will fail with a
 * UNIQUE constraint error on (user_id, session_date). This is acceptable for a small
 * personal app where concurrent writes to the same date are not expected.
 */
export async function getOrCreateSession(
	db: D1Database,
	userId: number,
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

	// Try to find existing session owned by this user
	const existing = await getSessionByDate(db, userId, sessionDate);
	if (existing) {
		return { session: existing, created: false };
	}

	// Create new session. user_id is written explicitly; the schema DEFAULT 1 is
	// only a compatibility bridge for pre-Phase 2 code.
	const result = await db
		.prepare(
			`INSERT INTO workout_sessions (user_id, session_date, goal, body_condition, notes)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(userId, sessionDate, goal, bodyCondition, notes)
		.run();

	const session = await getSessionById(db, userId, result.meta.last_row_id);
	if (!session) throw new Error("Failed to retrieve created session");

	return { session, created: true };
}

/**
 * Get a session by ID, scoped to the given user.
 * Another user's row is treated as non-existent so the caller can return 404
 * without leaking the row's existence.
 */
export async function getSessionById(
	db: D1Database,
	userId: number,
	id: number,
): Promise<WorkoutSessionRow | null> {
	return db
		.prepare("SELECT * FROM workout_sessions WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.first<WorkoutSessionRow>();
}

/**
 * Get a session by date (YYYY-MM-DD), scoped to the given user.
 */
export async function getSessionByDate(
	db: D1Database,
	userId: number,
	date: string,
): Promise<WorkoutSessionRow | null> {
	return db
		.prepare(
			"SELECT * FROM workout_sessions WHERE user_id = ? AND session_date = ?",
		)
		.bind(userId, date)
		.first<WorkoutSessionRow>();
}

/**
 * True when the session exists and belongs to the given user.
 * Shared ownership guard for child tables (session_exercises / sets / photos),
 * whose ownership is derived from the parent workout_sessions row.
 */
export async function assertSessionOwned(
	db: D1Database,
	userId: number,
	sessionId: number,
): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT 1 AS ok FROM workout_sessions WHERE id = ? AND user_id = ?",
		)
		.bind(sessionId, userId)
		.first<{ ok: number }>();
	return row !== null;
}

/**
 * Get sessions for a specific month, scoped to the given user.
 */
export async function getSessionsByMonth(
	db: D1Database,
	userId: number,
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
			 WHERE user_id = ? AND session_date >= ? AND session_date < ?
			 ORDER BY session_date`,
		)
		.bind(userId, startDate, endDate)
		.all<WorkoutSessionRow>();

	return results;
}

/**
 * Get the most recent N sessions for the given user.
 */
export async function getRecentSessions(
	db: D1Database,
	userId: number,
	limit: number,
): Promise<WorkoutSessionRow[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM workout_sessions
			 WHERE user_id = ?
			 ORDER BY session_date DESC LIMIT ?`,
		)
		.bind(userId, limit)
		.all<WorkoutSessionRow>();
	return results;
}

/**
 * Update session metadata fields for a session owned by the given user.
 * Only specified (non-undefined) fields are updated. Another user's session is
 * not touched. If no fields are provided, this is a no-op.
 */
export async function updateSession(
	db: D1Database,
	userId: number,
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

	values.push(id, userId);
	await db
		.prepare(
			`UPDATE workout_sessions SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`,
		)
		.bind(...values)
		.run();
}

/**
 * Delete a session by ID owned by the given user. Returns true if a row was deleted.
 * Deletes R2 photos first, then CASCADE deletes photo rows, session exercises,
 * and sets. If an R2 deletion fails, the D1 session remains for safe retry.
 */
export async function deleteSession(
	env: Pick<Bindings, "DB" | "PHOTOS">,
	userId: number,
	id: number,
): Promise<boolean> {
	const session = await getSessionById(env.DB, userId, id);
	if (!session) return false;
	await deleteSessionPhotosForSession(env, userId, id);
	const result = await env.DB.prepare(
		"DELETE FROM workout_sessions WHERE id = ? AND user_id = ?",
	)
		.bind(id, userId)
		.run();
	const deleted = result.meta.changes > 0;
	if (deleted) {
		await sweepSessionPhotoObjects(
			env.PHOTOS,
			userId,
			session.session_date,
			session.id,
		);
	}
	return deleted;
}
