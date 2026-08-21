import type { ExerciseAliasRow, ExerciseRow } from "./types.js";

/** Exercise with its aliases */
export interface ExerciseWithAliases {
	exercise: ExerciseRow;
	aliases: ExerciseAliasRow[];
}

/**
 * 3-stage exercise search:
 * 1. Exact match on exercises.name (COLLATE NOCASE)
 * 2. Exact match on exercise_aliases.alias (COLLATE NOCASE)
 * 3. Partial match (LIKE '%query%') on both name and alias
 *
 * If no query provided, returns all exercises (optionally filtered by category).
 */
export async function searchExercises(
	db: D1Database,
	query?: string,
	category?: ExerciseRow["category"],
): Promise<ExerciseWithAliases[]> {
	if (!query) {
		const { results } = category
			? await db
					.prepare("SELECT * FROM exercises WHERE category = ? ORDER BY name")
					.bind(category)
					.all<ExerciseRow>()
			: await db
					.prepare("SELECT * FROM exercises ORDER BY name")
					.all<ExerciseRow>();
		return attachAliases(db, results);
	}

	// Stage 1: exact match on exercises.name (COLLATE NOCASE is on the column)
	{
		const { results } = category
			? await db
					.prepare("SELECT * FROM exercises WHERE name = ? AND category = ?")
					.bind(query, category)
					.all<ExerciseRow>()
			: await db
					.prepare("SELECT * FROM exercises WHERE name = ?")
					.bind(query)
					.all<ExerciseRow>();
		if (results.length > 0) return attachAliases(db, results);
	}

	// Stage 2: exact match on exercise_aliases.alias (COLLATE NOCASE is on the column)
	{
		const sql = category
			? `SELECT DISTINCT e.* FROM exercises e
			   JOIN exercise_aliases ea ON e.id = ea.exercise_id
			   WHERE ea.alias = ? AND e.category = ?`
			: `SELECT DISTINCT e.* FROM exercises e
			   JOIN exercise_aliases ea ON e.id = ea.exercise_id
			   WHERE ea.alias = ?`;
		const { results } = category
			? await db.prepare(sql).bind(query, category).all<ExerciseRow>()
			: await db.prepare(sql).bind(query).all<ExerciseRow>();
		if (results.length > 0) return attachAliases(db, results);
	}

	// Stage 3: partial match (LIKE) on both name and alias
	{
		const pattern = `%${query}%`;
		const sql = category
			? `SELECT DISTINCT e.* FROM exercises e
			   LEFT JOIN exercise_aliases ea ON e.id = ea.exercise_id
			   WHERE (e.name LIKE ? OR ea.alias LIKE ?) AND e.category = ?
			   ORDER BY e.name`
			: `SELECT DISTINCT e.* FROM exercises e
			   LEFT JOIN exercise_aliases ea ON e.id = ea.exercise_id
			   WHERE (e.name LIKE ? OR ea.alias LIKE ?)
			   ORDER BY e.name`;
		const { results } = category
			? await db
					.prepare(sql)
					.bind(pattern, pattern, category)
					.all<ExerciseRow>()
			: await db.prepare(sql).bind(pattern, pattern).all<ExerciseRow>();
		return attachAliases(db, results);
	}
}

/**
 * Find a single exercise by name using the 3-stage resolution.
 * Returns the first match or null.
 */
export async function findExerciseByName(
	db: D1Database,
	name: string,
): Promise<ExerciseRow | null> {
	// Stage 1: exact match on exercises.name
	const exact = await db
		.prepare("SELECT * FROM exercises WHERE name = ?")
		.bind(name)
		.first<ExerciseRow>();
	if (exact) return exact;

	// Stage 2: exact match on exercise_aliases.alias
	const aliasMatch = await db
		.prepare(
			`SELECT e.* FROM exercises e
			 JOIN exercise_aliases ea ON e.id = ea.exercise_id
			 WHERE ea.alias = ?`,
		)
		.bind(name)
		.first<ExerciseRow>();
	if (aliasMatch) return aliasMatch;

	// Stage 3: partial match on both name and alias
	const pattern = `%${name}%`;
	return db
		.prepare(
			`SELECT DISTINCT e.* FROM exercises e
			 LEFT JOIN exercise_aliases ea ON e.id = ea.exercise_id
			 WHERE e.name LIKE ? OR ea.alias LIKE ?
			 ORDER BY e.name
			 LIMIT 1`,
		)
		.bind(pattern, pattern)
		.first<ExerciseRow>();
}

/**
 * Register a new exercise with optional aliases.
 */
export async function registerExercise(
	db: D1Database,
	params: {
		name: string;
		category?: ExerciseRow["category"];
		equipment?: string | null;
		target_muscles?: string | null;
		notes?: string | null;
		aliases?: string[];
	},
): Promise<ExerciseWithAliases> {
	const {
		name,
		category = "strength",
		equipment = null,
		target_muscles = null,
		notes = null,
		aliases = [],
	} = params;

	const result = await db
		.prepare(
			`INSERT INTO exercises (name, category, equipment, target_muscles, notes)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(name, category, equipment, target_muscles, notes)
		.run();

	const exerciseId = result.meta.last_row_id;

	const insertedAliases: ExerciseAliasRow[] = [];
	for (const alias of aliases) {
		const aliasResult = await db
			.prepare(
				"INSERT INTO exercise_aliases (exercise_id, alias) VALUES (?, ?)",
			)
			.bind(exerciseId, alias)
			.run();
		insertedAliases.push({
			id: aliasResult.meta.last_row_id,
			exercise_id: exerciseId,
			alias,
		});
	}

	const exercise = await getExerciseById(db, exerciseId);
	if (!exercise) throw new Error("Failed to retrieve registered exercise");

	return { exercise, aliases: insertedAliases };
}

/**
 * Get exercise by ID.
 */
export async function getExerciseById(
	db: D1Database,
	id: number,
): Promise<ExerciseRow | null> {
	return db
		.prepare("SELECT * FROM exercises WHERE id = ?")
		.bind(id)
		.first<ExerciseRow>();
}

/**
 * Get aliases for an exercise.
 */
export async function getExerciseAliases(
	db: D1Database,
	exerciseId: number,
): Promise<ExerciseAliasRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM exercise_aliases WHERE exercise_id = ?")
		.bind(exerciseId)
		.all<ExerciseAliasRow>();
	return results;
}

// ---- Internal helpers ----

async function attachAliases(
	db: D1Database,
	exercises: ExerciseRow[],
): Promise<ExerciseWithAliases[]> {
	const result: ExerciseWithAliases[] = [];
	for (const exercise of exercises) {
		const aliases = await getExerciseAliases(db, exercise.id);
		result.push({ exercise, aliases });
	}
	return result;
}
