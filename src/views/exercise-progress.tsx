import type { Hono } from "hono";
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { getExerciseAliases, getExerciseById } from "../db/exercises.js";
import type { ExerciseAliasRow, ExerciseRow } from "../db/types.js";
import type { Bindings } from "../env.js";
import {
	ChartContainer,
	type ChartData,
	type ChartDataset,
} from "./components/chart.js";
import { getExerciseAnatomy, MuscleMap } from "./components/muscle-map.js";
import { Layout } from "./layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Period = "1m" | "3m" | "6m" | "all";

/** Row from the strength chart query */
interface StrengthChartRow {
	session_date: string;
	weight_unit: string;
	max_weight: number;
}

/** Row from the cardio chart query */
interface CardioChartRow {
	session_date: string;
	max_speed: number;
}

/** Row from the history query */
interface HistoryRow {
	session_date: string;
	equipment_note: string | null;
	status: string;
	reps: number | null;
	weight_value: number | null;
	weight_unit: string | null;
	duration_minutes: number | null;
	speed_min: number | null;
	speed_max: number | null;
	incline_percent: number | null;
	angle_degrees: number | null;
}

/** Grouped history entry (one per session date) */
interface HistoryEntry {
	sessionDate: string;
	sets: HistorySetInfo[];
}

interface HistorySetInfo {
	reps: number | null;
	weightValue: number | null;
	weightUnit: string | null;
	durationMinutes: number | null;
	speedMin: number | null;
	speedMax: number | null;
	inclinePercent: number | null;
	angleDegrees: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
	strength: "筋力",
	cardio: "有酸素",
	flexibility: "柔軟",
	other: "その他",
};

function categoryLabel(category: string): string {
	return CATEGORY_LABELS[category] ?? category;
}

const VALID_PERIODS = new Set<string>(["1m", "3m", "6m", "all"]);

function parsePeriod(value: string | undefined): Period {
	if (value && VALID_PERIODS.has(value)) {
		return value as Period;
	}
	return "all";
}

/**
 * Calculate the date cutoff for a given period.
 * Returns undefined for "all" (no filter).
 */
function getDateFrom(period: Period): string | undefined {
	if (period === "all") return undefined;

	const now = new Date();
	switch (period) {
		case "1m":
			now.setMonth(now.getMonth() - 1);
			break;
		case "3m":
			now.setMonth(now.getMonth() - 3);
			break;
		case "6m":
			now.setMonth(now.getMonth() - 6);
			break;
	}

	return now.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Data access (direct SQL – not modifying src/db/)
// ---------------------------------------------------------------------------

async function fetchStrengthChartData(
	db: D1Database,
	exerciseId: number,
	dateFrom: string | undefined,
): Promise<ChartData> {
	let sql = `
		SELECT ws.session_date, s.weight_unit, MAX(s.weight_value) AS max_weight
		FROM sets s
		JOIN session_exercises se ON s.session_exercise_id = se.id
		JOIN workout_sessions ws ON se.session_id = ws.id
		WHERE se.exercise_id = ?
		  AND s.is_planned = 0
		  AND s.weight_value IS NOT NULL
		  AND s.weight_unit IS NOT NULL`;

	const bindings: (number | string)[] = [exerciseId];

	if (dateFrom) {
		sql += " AND ws.session_date >= ?";
		bindings.push(dateFrom);
	}

	sql += " GROUP BY ws.session_date, s.weight_unit ORDER BY ws.session_date";

	const { results } = await db
		.prepare(sql)
		.bind(...bindings)
		.all<StrengthChartRow>();

	// Build unique sorted date labels
	const labelSet = new Set<string>();
	for (const row of results) {
		labelSet.add(row.session_date);
	}
	const labels = [...labelSet].sort();

	// Group by unit
	const unitMap = new Map<string, Map<string, number>>();
	for (const row of results) {
		let dateMap = unitMap.get(row.weight_unit);
		if (!dateMap) {
			dateMap = new Map<string, number>();
			unitMap.set(row.weight_unit, dateMap);
		}
		dateMap.set(row.session_date, row.max_weight);
	}

	const datasets: ChartDataset[] = [];
	for (const [unit, dateMap] of unitMap) {
		datasets.push({
			unit,
			values: labels.map((date) => dateMap.get(date) ?? null),
		});
	}

	return { labels, datasets, type: "weight" };
}

async function fetchCardioChartData(
	db: D1Database,
	exerciseId: number,
	dateFrom: string | undefined,
): Promise<ChartData> {
	let sql = `
		SELECT ws.session_date, MAX(s.speed_max) AS max_speed
		FROM sets s
		JOIN session_exercises se ON s.session_exercise_id = se.id
		JOIN workout_sessions ws ON se.session_id = ws.id
		WHERE se.exercise_id = ?
		  AND s.is_planned = 0
		  AND s.speed_max IS NOT NULL`;

	const bindings: (number | string)[] = [exerciseId];

	if (dateFrom) {
		sql += " AND ws.session_date >= ?";
		bindings.push(dateFrom);
	}

	sql += " GROUP BY ws.session_date ORDER BY ws.session_date";

	const { results } = await db
		.prepare(sql)
		.bind(...bindings)
		.all<CardioChartRow>();

	const labels = results.map((r) => r.session_date);
	const datasets: ChartDataset[] =
		results.length > 0
			? [
					{
						unit: "km/h",
						values: results.map((r) => r.max_speed),
					},
				]
			: [];

	return { labels, datasets, type: "speed" };
}

async function fetchChartData(
	db: D1Database,
	exercise: ExerciseRow,
	dateFrom: string | undefined,
): Promise<ChartData> {
	switch (exercise.category) {
		case "strength":
			return fetchStrengthChartData(db, exercise.id, dateFrom);
		case "cardio":
			return fetchCardioChartData(db, exercise.id, dateFrom);
		default:
			// flexibility / other: no chart data
			return { labels: [], datasets: [], type: "weight" };
	}
}

async function fetchHistory(
	db: D1Database,
	exerciseId: number,
	dateFrom: string | undefined,
): Promise<HistoryEntry[]> {
	let sql = `
		SELECT ws.session_date, se.equipment_note, se.status,
		       s.reps, s.weight_value, s.weight_unit,
		       s.duration_minutes, s.speed_min, s.speed_max,
		       s.incline_percent, s.angle_degrees
		FROM session_exercises se
		JOIN workout_sessions ws ON se.session_id = ws.id
		LEFT JOIN sets s ON se.id = s.session_exercise_id AND s.is_planned = 0
		WHERE se.exercise_id = ?`;

	const bindings: (number | string)[] = [exerciseId];

	if (dateFrom) {
		sql += " AND ws.session_date >= ?";
		bindings.push(dateFrom);
	}

	sql += " ORDER BY ws.session_date DESC, s.set_order";

	const { results } = await db
		.prepare(sql)
		.bind(...bindings)
		.all<HistoryRow>();

	// Group by session_date
	const entryMap = new Map<string, HistorySetInfo[]>();
	for (const row of results) {
		let sets = entryMap.get(row.session_date);
		if (!sets) {
			sets = [];
			entryMap.set(row.session_date, sets);
		}
		// Only add if there's actual set data (LEFT JOIN may produce null set)
		if (
			row.reps !== null ||
			row.weight_value !== null ||
			row.duration_minutes !== null ||
			row.speed_max !== null ||
			row.angle_degrees !== null
		) {
			sets.push({
				reps: row.reps,
				weightValue: row.weight_value,
				weightUnit: row.weight_unit,
				durationMinutes: row.duration_minutes,
				speedMin: row.speed_min,
				speedMax: row.speed_max,
				inclinePercent: row.incline_percent,
				angleDegrees: row.angle_degrees,
			});
		}
	}

	const entries: HistoryEntry[] = [];
	for (const [sessionDate, sets] of entryMap) {
		entries.push({ sessionDate, sets });
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
	{ value: "1m", label: "1M" },
	{ value: "3m", label: "3M" },
	{ value: "6m", label: "6M" },
	{ value: "all", label: "全期間" },
];

const PeriodFilter: FC<{
	exerciseId: number;
	active: Period;
}> = ({ exerciseId, active }) => (
	<div id="period-filter">
		{PERIOD_OPTIONS.map((opt) => {
			const isActive = opt.value === active;
			return (
				<button
					type="button"
					hx-get={`/exercises/${exerciseId}?period=${opt.value}`}
					hx-target="#chart-section"
					hx-swap="innerHTML transition:true"
					hx-push-url="true"
					class={isActive ? "period-btn active" : "period-btn"}
				>
					{opt.label}
				</button>
			);
		})}
	</div>
);

/** Format a single set for display in the history table */
function formatSet(set: HistorySetInfo, category: string): string {
	if (category === "cardio") {
		const parts: string[] = [];
		if (set.durationMinutes !== null) {
			parts.push(`${set.durationMinutes}分`);
		}
		if (set.inclinePercent !== null) {
			parts.push(`傾斜${set.inclinePercent}%`);
		}
		if (set.speedMin !== null && set.speedMax !== null) {
			parts.push(`${set.speedMin}~${set.speedMax}km/h`);
		} else if (set.speedMax !== null) {
			parts.push(`${set.speedMax}km/h`);
		}
		return parts.join(" / ");
	}

	if (category === "flexibility") {
		if (set.angleDegrees !== null) {
			return `${set.angleDegrees}度`;
		}
		if (set.reps !== null) {
			return `${set.reps}rep`;
		}
		return "-";
	}

	// strength / other
	const parts: string[] = [];
	if (set.reps !== null && set.weightValue !== null && set.weightUnit) {
		parts.push(`${set.reps}x${set.weightValue}${set.weightUnit}`);
	} else if (set.reps !== null) {
		parts.push(`${set.reps}rep`);
	} else if (set.weightValue !== null && set.weightUnit) {
		parts.push(`${set.weightValue}${set.weightUnit}`);
	}
	return parts.join(", ") || "-";
}

/** Get the headline metric for the history table (e.g. max weight or max speed) */
function getHeadlineMetric(sets: HistorySetInfo[], category: string): string {
	if (category === "cardio") {
		const speeds = sets
			.map((s) => s.speedMax)
			.filter((v): v is number => v !== null);
		if (speeds.length > 0) {
			return `${Math.max(...speeds)}km/h`;
		}
		return "-";
	}

	if (category === "strength" || category === "other") {
		let maxWeight = 0;
		let maxUnit = "";
		for (const s of sets) {
			if (s.weightValue !== null && s.weightUnit !== null) {
				if (s.weightValue > maxWeight) {
					maxWeight = s.weightValue;
					maxUnit = s.weightUnit;
				}
			}
		}
		if (maxWeight > 0) {
			return `${maxWeight}${maxUnit}`;
		}
		return "-";
	}

	// flexibility
	const angles = sets
		.map((s) => s.angleDegrees)
		.filter((v): v is number => v !== null);
	if (angles.length > 0) {
		return `${Math.max(...angles)}度`;
	}
	return "-";
}

const HistoryTable: FC<{
	entries: HistoryEntry[];
	category: string;
}> = ({ entries, category }) => {
	if (entries.length === 0) {
		return <p id="history-empty">履歴がありません</p>;
	}

	const metricHeader =
		category === "cardio"
			? "速度"
			: category === "flexibility"
				? "角度"
				: "重量";

	return (
		<table id="history-table">
			<thead>
				<tr>
					<th>日付</th>
					<th>{metricHeader}</th>
					<th>セット</th>
				</tr>
			</thead>
			<tbody>
				{entries.map((entry) => (
					<tr>
						<td>{entry.sessionDate}</td>
						<td>{getHeadlineMetric(entry.sets, category)}</td>
						<td>
							{entry.sets.length > 0
								? entry.sets.map((s) => formatSet(s, category)).join(", ")
								: "-"}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
};

const ExerciseInfo: FC<{
	exercise: ExerciseRow;
	aliases: ExerciseAliasRow[];
}> = ({ exercise, aliases }) => (
	<div id="exercise-info">
		<h1>{exercise.name}</h1>
		<dl>
			<dt>カテゴリ</dt>
			<dd>{categoryLabel(exercise.category)}</dd>
			{exercise.equipment && (
				<>
					<dt>器具</dt>
					<dd>{exercise.equipment}</dd>
				</>
			)}
			{exercise.target_muscles && (
				<>
					<dt>部位メモ</dt>
					<dd>{exercise.target_muscles}</dd>
				</>
			)}
			{aliases.length > 0 && (
				<>
					<dt>別名</dt>
					<dd>{aliases.map((a) => a.alias).join(", ")}</dd>
				</>
			)}
		</dl>
	</div>
);

/**
 * The content that goes inside #chart-section.
 * This is returned as-is for htmx partial updates,
 * or embedded in the full page for initial loads.
 */
const ChartSectionContent: FC<{
	exerciseId: number;
	period: Period;
	chartData: ChartData;
	history: HistoryEntry[];
	category: string;
	isPartial: boolean;
}> = ({ exerciseId, period, chartData, history, category, isPartial }) => (
	<>
		<PeriodFilter exerciseId={exerciseId} active={period} />
		<ChartContainer data={chartData} />
		<HistoryTable entries={history} category={category} />
		{isPartial &&
			raw(
				"<script>if(window.initProgressChart)window.initProgressChart();</script>",
			)}
	</>
);

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerExerciseProgressRoutes(
	app: Hono<{ Bindings: Bindings }>,
): void {
	app.get("/exercises/:id", async (c) => {
		const id = Number.parseInt(c.req.param("id"), 10);
		if (Number.isNaN(id)) {
			return c.text("Invalid exercise ID", 400);
		}

		const exercise = await getExerciseById(c.env.DB, id);
		if (!exercise) {
			return c.text("Exercise not found", 404);
		}

		const period = parsePeriod(c.req.query("period"));
		const dateFrom = getDateFrom(period);
		const isHtmx = c.req.header("HX-Request") === "true";

		const [aliases, chartData, history] = await Promise.all([
			getExerciseAliases(c.env.DB, id),
			fetchChartData(c.env.DB, exercise, dateFrom),
			fetchHistory(c.env.DB, id, dateFrom),
		]);

		if (isHtmx) {
			return c.html(
				<ChartSectionContent
					exerciseId={id}
					period={period}
					chartData={chartData}
					history={history}
					category={exercise.category}
					isPartial={true}
				/>,
			);
		}

		return c.html(
			<Layout title={exercise.name} activeNav="exercises">
				<ExerciseInfo exercise={exercise} aliases={aliases} />
				<MuscleMap
					anatomy={getExerciseAnatomy(exercise)}
					context="exercise"
					category={exercise.category}
				/>
				<div id="chart-section">
					<ChartSectionContent
						exerciseId={id}
						period={period}
						chartData={chartData}
						history={history}
						category={exercise.category}
						isPartial={false}
					/>
				</div>
				<script src="https://cdn.jsdelivr.net/npm/chart.js" />
				<script src="/js/chart-init.js" />
			</Layout>,
		);
	});
}
