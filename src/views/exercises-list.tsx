import type { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Bindings } from "../env.js";
import { Layout } from "./layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row returned by the exercises-with-stats query */
interface ExerciseListRow {
	id: number;
	name: string;
	category: string;
	equipment: string | null;
	last_performed: string | null;
	total_sessions: number;
}

type CategoryFilter =
	| "strength"
	| "cardio"
	| "flexibility"
	| "other"
	| undefined;

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

const VALID_CATEGORIES = new Set<string>([
	"strength",
	"cardio",
	"flexibility",
	"other",
]);

function parseCategory(value: string | undefined): CategoryFilter {
	if (value && VALID_CATEGORIES.has(value)) {
		return value as CategoryFilter;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Data access (direct SQL – not modifying src/db/)
// ---------------------------------------------------------------------------

async function fetchExerciseList(
	db: D1Database,
	category: CategoryFilter,
): Promise<ExerciseListRow[]> {
	let sql = `
		SELECT e.id, e.name, e.category, e.equipment,
		       MAX(ws.session_date) AS last_performed,
		       COUNT(DISTINCT se.session_id) AS total_sessions
		FROM exercises e
		LEFT JOIN session_exercises se ON e.id = se.exercise_id
		LEFT JOIN workout_sessions ws ON se.session_id = ws.id`;

	const bindings: string[] = [];

	if (category) {
		sql += " WHERE e.category = ?";
		bindings.push(category);
	}

	sql += " GROUP BY e.id ORDER BY e.name";

	const stmt =
		bindings.length > 0 ? db.prepare(sql).bind(...bindings) : db.prepare(sql);
	const { results } = await stmt.all<ExerciseListRow>();
	return results;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const CATEGORIES: { value: CategoryFilter; label: string }[] = [
	{ value: undefined, label: "全て" },
	{ value: "strength", label: "筋力" },
	{ value: "cardio", label: "有酸素" },
	{ value: "flexibility", label: "柔軟" },
	{ value: "other", label: "その他" },
];

const CategoryTabs: FC<{
	active: CategoryFilter;
}> = ({ active }) => (
	<div id="category-tabs">
		{CATEGORIES.map((cat) => {
			const url = cat.value ? `/exercises?category=${cat.value}` : "/exercises";
			const isActive = cat.value === active;
			return (
				<button
					type="button"
					hx-get={url}
					hx-target="#exercises-content"
					hx-swap="innerHTML"
					hx-push-url="true"
					class={isActive ? "tab active" : "tab"}
				>
					{cat.label}
				</button>
			);
		})}
	</div>
);

const ExerciseCard: FC<{ exercise: ExerciseListRow }> = ({ exercise }) => (
	<a href={`/exercises/${exercise.id}`} class="exercise-card">
		<div class="exercise-card-header">
			<span class="exercise-name">{exercise.name}</span>
			<span class="exercise-category">{categoryLabel(exercise.category)}</span>
		</div>
		{exercise.equipment && (
			<div class="exercise-equipment">器具: {exercise.equipment}</div>
		)}
		<div class="exercise-meta">
			<span>最終: {exercise.last_performed ?? "-"}</span>
			<span>回数: {exercise.total_sessions}</span>
		</div>
	</a>
);

const ExercisesPageContent: FC<{
	exercises: ExerciseListRow[];
	activeCategory: CategoryFilter;
}> = ({ exercises, activeCategory }) => (
	<>
		<CategoryTabs active={activeCategory} />
		<div id="exercise-list">
			{exercises.length === 0 ? (
				<p>種目が登録されていません</p>
			) : (
				exercises.map((ex) => <ExerciseCard exercise={ex} />)
			)}
		</div>
	</>
);

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerExerciseListRoutes(
	app: Hono<{ Bindings: Bindings }>,
): void {
	app.get("/exercises", async (c) => {
		const category = parseCategory(c.req.query("category"));
		const exercises = await fetchExerciseList(c.env.DB, category);
		const isHtmx = c.req.header("HX-Request") === "true";

		if (isHtmx) {
			return c.html(
				<ExercisesPageContent
					exercises={exercises}
					activeCategory={category}
				/>,
			);
		}

		return c.html(
			<Layout title="種目一覧 - training-logger" activeNav="exercises">
				<h1>種目一覧</h1>
				<div id="exercises-content">
					<ExercisesPageContent
						exercises={exercises}
						activeCategory={category}
					/>
				</div>
			</Layout>,
		);
	});
}
