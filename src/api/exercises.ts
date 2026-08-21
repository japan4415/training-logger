import type { Context } from "hono";
import {
	getExerciseAliases,
	getExerciseById,
	searchExercises,
} from "../db/exercises.js";
import { getExerciseStats } from "../db/queries.js";
import type { ExerciseRow } from "../db/types.js";
import type { Bindings } from "../env.js";

const VALID_CATEGORIES = new Set<string>([
	"strength",
	"cardio",
	"flexibility",
	"other",
]);

/**
 * GET /api/exercises
 *
 * Query params:
 *   category - strength | cardio | flexibility | other
 *   q        - search query (name or alias)
 */
export async function listExercises(c: Context<{ Bindings: Bindings }>) {
	const db = c.env.DB;
	const category = c.req.query("category");
	const q = c.req.query("q");

	if (category && !VALID_CATEGORIES.has(category)) {
		return c.json({ error: "Invalid category" }, 400);
	}

	const exercisesWithAliases = await searchExercises(
		db,
		q,
		category as ExerciseRow["category"] | undefined,
	);

	// Enrich each exercise with last_performed and total_sessions
	const exercises = await Promise.all(
		exercisesWithAliases.map(async ({ exercise }) => {
			const stats = await getExerciseStats(db, exercise.id);
			return {
				id: exercise.id,
				name: exercise.name,
				category: exercise.category,
				equipment: exercise.equipment,
				target_muscles: exercise.target_muscles,
				last_performed: stats?.sessionSummaries[0]?.sessionDate ?? null,
				total_sessions: stats?.totalSessions ?? 0,
			};
		}),
	);

	return c.json({ exercises });
}

/**
 * GET /api/exercises/:id
 *
 * Returns exercise detail with aliases.
 */
export async function getExercise(c: Context<{ Bindings: Bindings }>) {
	const db = c.env.DB;
	const id = Number(c.req.param("id"));

	if (Number.isNaN(id) || id <= 0 || !Number.isInteger(id)) {
		return c.json({ error: "Invalid exercise ID" }, 400);
	}

	const exercise = await getExerciseById(db, id);
	if (!exercise) {
		return c.json({ error: "Exercise not found" }, 404);
	}

	const aliasRows = await getExerciseAliases(db, id);

	return c.json({
		exercise: {
			id: exercise.id,
			name: exercise.name,
			category: exercise.category,
			equipment: exercise.equipment,
			target_muscles: exercise.target_muscles,
			aliases: aliasRows.map((a) => a.alias),
		},
	});
}
