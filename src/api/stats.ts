import type { Context } from "hono";
import { getExerciseById } from "../db/exercises.js";
import { getHistory } from "../db/queries.js";
import type { SetRow } from "../db/types.js";
import type { Bindings } from "../env.js";

const VALID_PERIODS = new Set(["1m", "3m", "6m", "all"]);
const PERIOD_MONTHS: Record<string, number> = { "1m": 1, "3m": 3, "6m": 6 };
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** Check that a string is a valid YYYY-MM-DD date (format + real date). */
function isValidDateString(value: string): boolean {
	if (!DATE_FORMAT.test(value)) return false;
	const [y, m, d] = value.split("-").map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	return (
		date.getUTCFullYear() === y &&
		date.getUTCMonth() === m - 1 &&
		date.getUTCDate() === d
	);
}

/**
 * Resolve a date-range `from` value.
 * Explicit `from` takes precedence over `period`.
 */
function resolveFromDate(
	from: string | undefined,
	period: string | undefined,
): string | undefined {
	if (from) return from;
	if (!period || period === "all") return undefined;

	const months = PERIOD_MONTHS[period];
	if (!months) return undefined;

	const now = new Date();
	now.setUTCMonth(now.getUTCMonth() - months);
	return now.toISOString().slice(0, 10);
}

/** Compute max weight per unit from a list of sets. */
function computeMaxWeightByUnit(sets: SetRow[]): Record<string, number> {
	const result: Record<string, number> = {};
	for (const set of sets) {
		if (set.weight_value != null && set.weight_unit != null) {
			const current = result[set.weight_unit];
			if (current === undefined || set.weight_value > current) {
				result[set.weight_unit] = set.weight_value;
			}
		}
	}
	return result;
}

/**
 * GET /api/exercises/:id/stats
 *
 * Query params:
 *   from   - YYYY-MM-DD
 *   to     - YYYY-MM-DD
 *   period - 1m | 3m | 6m | all  (shorthand for `from`)
 */
export async function getExerciseStatsHandler(
	c: Context<{ Bindings: Bindings }>,
) {
	const db = c.env.DB;
	const id = Number(c.req.param("id"));

	if (Number.isNaN(id) || id <= 0 || !Number.isInteger(id)) {
		return c.json({ error: "Invalid exercise ID" }, 400);
	}

	const exercise = await getExerciseById(db, id);
	if (!exercise) {
		return c.json({ error: "Exercise not found" }, 404);
	}

	const fromParam = c.req.query("from");
	const toParam = c.req.query("to");
	const periodParam = c.req.query("period");

	if (fromParam && !isValidDateString(fromParam)) {
		return c.json({ error: "Invalid from date. Expected YYYY-MM-DD" }, 400);
	}

	if (toParam && !isValidDateString(toParam)) {
		return c.json({ error: "Invalid to date. Expected YYYY-MM-DD" }, 400);
	}

	if (periodParam && !VALID_PERIODS.has(periodParam)) {
		return c.json(
			{ error: "Invalid period. Expected 1m, 3m, 6m, or all" },
			400,
		);
	}

	const dateFrom = resolveFromDate(fromParam, periodParam);
	const dateTo = toParam;

	const details = await getHistory(db, {
		exerciseName: exercise.name,
		dateFrom,
		dateTo,
		includeSets: true,
	});

	const stats = details.map((d) => {
		// getHistory with exerciseName filters to the matching exercise only
		const exerciseDetail = d.exercises[0];
		if (!exerciseDetail) {
			return {
				date: d.session.session_date,
				max_weight_by_unit: {} as Record<string, number>,
				total_reps: 0,
				total_sets: 0,
				sets: [] as SetRow[],
			};
		}

		const actualSets = exerciseDetail.sets.filter((s) => s.is_planned === 0);

		return {
			date: d.session.session_date,
			max_weight_by_unit: computeMaxWeightByUnit(actualSets),
			total_reps: actualSets.reduce((sum, s) => sum + (s.reps ?? 0), 0),
			total_sets: actualSets.length,
			sets: actualSets,
		};
	});

	return c.json({ stats });
}
