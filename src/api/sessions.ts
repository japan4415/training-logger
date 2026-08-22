import type { Context } from "hono";
import { getHistory, getSessionDetail } from "../db/queries.js";
import type { Bindings } from "../env.js";

/** Derive day of week (Japanese) from YYYY-MM-DD string. */
function getDayOfWeek(dateStr: string): string {
	const days = ["日", "月", "火", "水", "木", "金", "土"];
	const date = new Date(`${dateStr}T00:00:00Z`);
	return days[date.getUTCDay()];
}

/** Parse YYYY-MM to year and month. Returns null on invalid format. */
function parseMonth(month: string): { year: number; month: number } | null {
	const match = /^(\d{4})-(\d{2})$/.exec(month);
	if (!match) return null;
	const year = Number(match[1]);
	const m = Number(match[2]);
	if (m < 1 || m > 12) return null;
	return { year, month: m };
}

/**
 * GET /api/sessions
 *
 * Query params:
 *   month  - YYYY-MM (defaults to current month)
 *   limit  - number  (defaults to 20)
 *   offset - number  (defaults to 0)
 */
export async function listSessions(c: Context<{ Bindings: Bindings }>) {
	const db = c.env.DB;

	const monthParam = c.req.query("month");
	const limitParam = c.req.query("limit");
	const offsetParam = c.req.query("offset");

	const limit = limitParam ? Number(limitParam) : 20;
	const offset = offsetParam ? Number(offsetParam) : 0;

	if (Number.isNaN(limit) || limit < 0) {
		return c.json({ error: "Invalid limit" }, 400);
	}
	if (Number.isNaN(offset) || offset < 0) {
		return c.json({ error: "Invalid offset" }, 400);
	}

	let year: number;
	let month: number;

	if (monthParam) {
		const parsed = parseMonth(monthParam);
		if (!parsed) {
			return c.json({ error: "Invalid month format. Expected YYYY-MM" }, 400);
		}
		year = parsed.year;
		month = parsed.month;
	} else {
		const now = new Date();
		year = now.getUTCFullYear();
		month = now.getUTCMonth() + 1;
	}

	// Date range for the month
	const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
	const lastDay = new Date(year, month, 0).getDate();
	const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

	// Fetch sessions with exercise info (no sets needed for list)
	const allDetails = await getHistory(db, {
		dateFrom: startDate,
		dateTo: endDate,
		includeSets: false,
	});

	const total = allDetails.length;
	const paginated = allDetails.slice(offset, offset + limit);

	const sessions = paginated.map((d) => ({
		id: d.session.id,
		date: d.session.session_date,
		day_of_week: getDayOfWeek(d.session.session_date),
		goal: d.session.goal,
		body_condition: d.session.body_condition,
		exercise_count: d.exercises.length,
		exercise_names: d.exercises.map((e) => e.exercise.name),
	}));

	return c.json({ sessions, total });
}

/**
 * GET /api/sessions/:id
 *
 * Returns full session detail with exercises split into sets / planned_sets.
 */
export async function getSession(c: Context<{ Bindings: Bindings }>) {
	const db = c.env.DB;
	const id = Number(c.req.param("id"));

	if (Number.isNaN(id) || id <= 0 || !Number.isInteger(id)) {
		return c.json({ error: "Invalid session ID" }, 400);
	}

	const detail = await getSessionDetail(db, id);
	if (!detail) {
		return c.json({ error: "Session not found" }, 404);
	}

	// Collect unique target muscles from all exercises
	const targetMusclesSet = new Set<string>();
	for (const e of detail.exercises) {
		if (e.exercise.target_muscles) {
			for (const part of e.exercise.target_muscles.split(",")) {
				const trimmed = part.trim();
				if (trimmed) {
					targetMusclesSet.add(trimmed);
				}
			}
		}
	}

	const session = {
		id: detail.session.id,
		date: detail.session.session_date,
		day_of_week: getDayOfWeek(detail.session.session_date),
		goal: detail.session.goal,
		body_condition: detail.session.body_condition,
		notes: detail.session.notes,
		target_muscles_summary: [...targetMusclesSet],
		exercises: detail.exercises.map((e) => ({
			id: e.sessionExercise.id,
			exercise_id: e.exercise.id,
			name: e.exercise.name,
			status: e.sessionExercise.status,
			equipment_note: e.sessionExercise.equipment_note,
			form_cues: e.sessionExercise.form_cues,
			target_muscles: e.exercise.target_muscles,
			sets: e.sets.filter((s) => s.is_planned === 0),
			planned_sets: e.sets.filter((s) => s.is_planned === 1),
		})),
	};

	return c.json({ session });
}
