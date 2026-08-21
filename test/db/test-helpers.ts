/**
 * Apply the initial D1 migration to set up tables for testing.
 * Uses IF NOT EXISTS to be idempotent across test files.
 * Uses db.batch() with individual prepared statements to avoid exec() parsing issues.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS exercises (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL COLLATE NOCASE UNIQUE,
			category TEXT NOT NULL DEFAULT 'strength' CHECK (category IN ('strength', 'cardio', 'flexibility', 'other')),
			equipment TEXT,
			target_muscles TEXT,
			notes TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS exercise_aliases (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
			alias TEXT NOT NULL COLLATE NOCASE UNIQUE
		)`),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_exercise_aliases_exercise_id ON exercise_aliases(exercise_id)",
		),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_exercise_aliases_alias ON exercise_aliases(alias COLLATE NOCASE)",
		),
		db.prepare(`CREATE TABLE IF NOT EXISTS workout_sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_date TEXT NOT NULL UNIQUE,
			goal TEXT,
			body_condition TEXT,
			notes TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		)`),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_workout_sessions_date ON workout_sessions(session_date)",
		),
		db.prepare(`CREATE TABLE IF NOT EXISTS session_exercises (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
			exercise_id INTEGER NOT NULL REFERENCES exercises(id),
			display_order INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('planned', 'completed', 'skipped')),
			equipment_note TEXT,
			form_cues TEXT,
			notes TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
			UNIQUE(session_id, display_order)
		)`),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_session_exercises_session ON session_exercises(session_id)",
		),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_session_exercises_exercise ON session_exercises(exercise_id)",
		),
		db.prepare(`CREATE TABLE IF NOT EXISTS sets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_exercise_id INTEGER NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
			set_order INTEGER NOT NULL,
			is_planned INTEGER NOT NULL DEFAULT 0 CHECK (is_planned IN (0, 1)),
			reps INTEGER,
			weight_value REAL,
			weight_unit TEXT CHECK (weight_unit IN ('kg', 'lbs', 'level') OR weight_unit IS NULL),
			duration_minutes REAL,
			distance_km REAL,
			speed_min REAL,
			speed_max REAL,
			incline_percent REAL,
			angle_degrees REAL,
			notes TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
			UNIQUE(session_exercise_id, set_order, is_planned)
		)`),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_sets_session_exercise ON sets(session_exercise_id)",
		),
	]);
}

/**
 * Clean all data from the database without dropping tables.
 * Deletes in foreign-key-safe order using batch for atomicity.
 */
export async function cleanDatabase(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM sets"),
		db.prepare("DELETE FROM session_exercises"),
		db.prepare("DELETE FROM workout_sessions"),
		db.prepare("DELETE FROM exercise_aliases"),
		db.prepare("DELETE FROM exercises"),
	]);
}
