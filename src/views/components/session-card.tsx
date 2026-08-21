import type { SessionExerciseDetail } from "../../db/queries.js";
import type { WorkoutSessionRow } from "../../db/types.js";

/** Get Japanese day-of-week string from a YYYY-MM-DD date string */
export function getDayOfWeek(dateStr: string): string {
	const days = ["日", "月", "火", "水", "木", "金", "土"];
	const date = new Date(`${dateStr}T00:00:00Z`);
	return days[date.getUTCDay()];
}

/** Format date as "YYYY/MM/DD (曜日)" */
export function formatDateWithDay(dateStr: string): string {
	const [y, m, d] = dateStr.split("-");
	return `${y}/${m}/${d} (${getDayOfWeek(dateStr)})`;
}

interface SessionCardProps {
	session: WorkoutSessionRow;
	exercises: SessionExerciseDetail[];
}

/** Maximum number of exercise names to show in the card */
const MAX_EXERCISE_NAMES = 3;

export function SessionCard(props: SessionCardProps) {
	const { session, exercises } = props;
	const exerciseCount = exercises.length;
	const exerciseNames = exercises
		.slice(0, MAX_EXERCISE_NAMES)
		.map((e) => e.exercise.name);
	const hasMore = exerciseCount > MAX_EXERCISE_NAMES;

	return (
		<a href={`/sessions/${session.id}`} class="session-card">
			<div class="session-card-date">
				{formatDateWithDay(session.session_date)}
			</div>
			{session.goal && (
				<div class="session-card-goal">Goal: {session.goal}</div>
			)}
			<div class="session-card-exercises">
				{exerciseCount}種目
				{exerciseCount > 0 && (
					<>
						: {exerciseNames.join(", ")}
						{hasMore && ", ..."}
					</>
				)}
			</div>
			{session.body_condition && (
				<div class="session-card-condition">体調: {session.body_condition}</div>
			)}
		</a>
	);
}
