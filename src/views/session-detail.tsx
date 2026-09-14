import type { Context } from "hono";
import { getSessionDetail } from "../db/queries.js";
import { listExistingSessionPhotos } from "../db/session-photos.js";
import { getSessionById } from "../db/sessions.js";
import type { Bindings } from "../env.js";
import { getSessionAnatomy, MuscleMap } from "./components/muscle-map.js";
import { formatDateWithDay } from "./components/session-card.js";
import { SessionPhotos } from "./components/session-photos.js";
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
	const anatomy = getSessionAnatomy(exercises);
	const photos = await listExistingSessionPhotos(c.env, id);

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
				<MuscleMap anatomy={anatomy} />

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

				<details class="session-photos" id="photos">
					<summary>写真 ({photos.length})</summary>
					<div
						id="session-photos-target"
						hx-get={`/sessions/${id}/photos`}
						hx-trigger="toggle once from:closest details"
						hx-target="this"
						hx-swap="innerHTML"
					>
						<p class="session-photos-fallback">
							<a href={`/sessions/${id}/photos`}>写真を表示</a>
						</p>
					</div>
				</details>

				{/* Back to list */}
				<div class="back-link">
					<a href="/">セッション一覧に戻る</a>
				</div>
			</div>
		</Layout>,
	);
}

export async function sessionPhotosHandler(
	c: Context<{ Bindings: Bindings }>,
): Promise<Response> {
	const idParam = c.req.param("id") ?? "";
	const id = Number.parseInt(idParam, 10);
	if (Number.isNaN(id)) {
		return c.html(
			<Layout title="セッション写真" activeNav="sessions">
				<p class="error-message">無効なセッションIDです</p>
			</Layout>,
			400,
		);
	}

	const session = await getSessionById(c.env.DB, id);
	if (!session) {
		return c.html(
			<Layout title="セッション写真" activeNav="sessions">
				<p class="error-message">セッションが見つかりません</p>
			</Layout>,
			404,
		);
	}

	const photos = await listExistingSessionPhotos(c.env, id);
	if (c.req.header("HX-Request") === "true") {
		return c.html(<SessionPhotos sessionId={id} photos={photos} />);
	}

	return c.html(
		<Layout title="セッション写真" activeNav="sessions">
			<div class="session-detail">
				<h1 class="session-photos-page-title">
					{formatDateWithDay(session.session_date)}の写真
				</h1>
				<div id="session-photos-target">
					<SessionPhotos sessionId={id} photos={photos} />
				</div>
				<div class="back-link">
					<a href={`/sessions/${id}#photos`}>セッション詳細に戻る</a>
				</div>
			</div>
		</Layout>,
	);
}
