import type { Context } from "hono";
import type { FC } from "hono/jsx";
import type { SessionExerciseDetail } from "../db/queries.js";
import { getSessionDetail } from "../db/queries.js";
import type { Bindings } from "../env.js";
import { formatDateWithDay } from "./components/session-card.js";
import { SetTable } from "./components/set-table.js";
import { Layout } from "./layout.js";

/** Status icon for session exercise: completed = check, planned = circle, skipped = cross */
function statusIcon(status: "planned" | "completed" | "skipped"): string {
	switch (status) {
		case "completed":
			return "✓"; // ✓
		case "planned":
			return "○"; // ○
		case "skipped":
			return "×"; // ×
	}
}

function statusClass(status: "planned" | "completed" | "skipped"): string {
	return `status-${status}`;
}

/**
 * Collect unique target muscle names from all exercises in a session.
 * Splits comma-separated values, trims whitespace, and deduplicates.
 * Exercises with null target_muscles are skipped.
 */
function collectTargetMuscles(exercises: SessionExerciseDetail[]): string[] {
	const muscleSet = new Set<string>();
	for (const { exercise } of exercises) {
		if (exercise.target_muscles) {
			for (const part of exercise.target_muscles.split(",")) {
				const trimmed = part.trim();
				if (trimmed) {
					muscleSet.add(trimmed);
				}
			}
		}
	}
	return [...muscleSet];
}

const TargetMusclesSummary: FC<{ muscles: string[] }> = ({ muscles }) => {
	if (muscles.length === 0) return null;
	return (
		<div class="target-muscles-summary">
			<span class="meta-label">鍛えた部位:</span>
			<div class="target-muscles-tags">
				{muscles.map((muscle) => (
					<span class="target-muscle-tag" key={muscle}>
						{muscle}
					</span>
				))}
			</div>
		</div>
	);
};

interface AdjacentSession {
	id: number;
	session_date: string;
}

export async function sessionDetailHandler(
	c: Context<{ Bindings: Bindings }>,
): Promise<Response> {
	const idParam = c.req.param("id") ?? "";
	const id = Number.parseInt(idParam, 10);
	if (Number.isNaN(id)) {
		return c.html(
			<Layout title="セッション詳細" activeNav="sessions">
				<p class="error-message">無効なセッションIDです</p>
			</Layout>,
			400,
		);
	}

	const db = c.env.DB;
	const detail = await getSessionDetail(db, id);

	if (!detail) {
		return c.html(
			<Layout title="セッション詳細" activeNav="sessions">
				<p class="error-message">セッションが見つかりません</p>
			</Layout>,
			404,
		);
	}

	// Find previous and next sessions for navigation
	const prevSession = await db
		.prepare(
			"SELECT id, session_date FROM workout_sessions WHERE session_date < ? ORDER BY session_date DESC LIMIT 1",
		)
		.bind(detail.session.session_date)
		.first<AdjacentSession>();

	const nextSession = await db
		.prepare(
			"SELECT id, session_date FROM workout_sessions WHERE session_date > ? ORDER BY session_date ASC LIMIT 1",
		)
		.bind(detail.session.session_date)
		.first<AdjacentSession>();

	const { session, exercises } = detail;
	const targetMuscles = collectTargetMuscles(exercises);

	return c.html(
		<Layout title="セッション詳細" activeNav="sessions">
			<div class="session-detail">
				{/* Navigation between sessions */}
				<div class="session-nav">
					{prevSession ? (
						<a href={`/sessions/${prevSession.id}`} class="session-nav-link">
							&lt; 前
						</a>
					) : (
						<span class="session-nav-placeholder" />
					)}
					<span class="session-nav-date">
						{formatDateWithDay(session.session_date)}
					</span>
					{nextSession ? (
						<a href={`/sessions/${nextSession.id}`} class="session-nav-link">
							次 &gt;
						</a>
					) : (
						<span class="session-nav-placeholder" />
					)}
				</div>

				{/* Session metadata */}
				<div class="session-meta">
					{session.goal && (
						<div class="session-meta-item">
							<span class="meta-label">Goal:</span> {session.goal}
						</div>
					)}
					<div class="session-meta-item">
						<span class="meta-label">体調:</span>{" "}
						{session.body_condition ?? "-"}
					</div>
					<div class="session-meta-item">
						<span class="meta-label">Notes:</span> {session.notes ?? "-"}
					</div>
				</div>

				{/* Target muscles summary */}
				<TargetMusclesSummary muscles={targetMuscles} />

				{/* Exercise list */}
				{exercises.length === 0 ? (
					<p class="empty-message">種目が登録されていません</p>
				) : (
					<div class="exercise-list">
						{exercises.map(({ sessionExercise, exercise, sets }) => (
							<div
								class={`exercise-card ${statusClass(sessionExercise.status)}`}
								key={sessionExercise.id}
							>
								<div class="exercise-card-header">
									<span
										class={`status-icon ${statusClass(sessionExercise.status)}`}
									>
										{statusIcon(sessionExercise.status)}
									</span>
									<a
										href={`/exercises/${exercise.id}`}
										class="exercise-name-link"
									>
										{exercise.name}
									</a>
									{sessionExercise.form_cues && (
										<span
											class="form-cues-indicator"
											title={sessionExercise.form_cues}
										>
											[cue]
										</span>
									)}
								</div>
								{sessionExercise.equipment_note && (
									<div class="exercise-equipment">
										器具: {sessionExercise.equipment_note}
									</div>
								)}
								{sessionExercise.notes && (
									<div class="exercise-notes">{sessionExercise.notes}</div>
								)}
								<SetTable category={exercise.category} sets={sets} />
							</div>
						))}
					</div>
				)}

				{/* Back to list */}
				<div class="back-link">
					<a href="/">セッション一覧に戻る</a>
				</div>
			</div>
		</Layout>,
	);
}
