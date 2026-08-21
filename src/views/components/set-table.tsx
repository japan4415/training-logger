import type { SetRow } from "../../db/types.js";

interface SetTableProps {
	category: "strength" | "cardio" | "flexibility" | "other";
	sets: SetRow[];
}

/** Format a single strength set as "reps x weight unit" or just "reps" */
function formatStrengthSet(set: SetRow): string {
	if (set.reps != null && set.weight_value != null && set.weight_unit != null) {
		if (set.weight_unit === "level") {
			return `${set.reps}x Lv.${set.weight_value}`;
		}
		return `${set.reps}x${set.weight_value}${set.weight_unit}`;
	}
	if (set.reps != null) {
		return `${set.reps}`;
	}
	return "-";
}

/** Format a single cardio set */
function formatCardioSet(set: SetRow): string {
	const parts: string[] = [];
	if (set.duration_minutes != null) {
		parts.push(`${set.duration_minutes}分`);
	}
	if (set.incline_percent != null) {
		parts.push(`傾斜${set.incline_percent}%`);
	}
	if (set.speed_min != null || set.speed_max != null) {
		if (
			set.speed_min != null &&
			set.speed_max != null &&
			set.speed_min !== set.speed_max
		) {
			parts.push(`${set.speed_min}~${set.speed_max}km/h`);
		} else {
			const speed = set.speed_min ?? set.speed_max;
			parts.push(`${speed}km/h`);
		}
	}
	if (set.distance_km != null) {
		parts.push(`${set.distance_km}km`);
	}
	return parts.length > 0 ? parts.join(" / ") : "-";
}

/** Format a single flexibility set */
function formatFlexibilitySet(set: SetRow): string {
	const parts: string[] = [];
	if (set.angle_degrees != null) {
		parts.push(`${set.angle_degrees}度`);
	}
	if (set.reps != null) {
		parts.push(`${set.reps}回`);
	}
	return parts.length > 0 ? parts.join(" / ") : "-";
}

/** Format a set based on exercise category */
function formatSet(
	category: "strength" | "cardio" | "flexibility" | "other",
	set: SetRow,
): string {
	switch (category) {
		case "cardio":
			return formatCardioSet(set);
		case "flexibility":
			return formatFlexibilitySet(set);
		default:
			return formatStrengthSet(set);
	}
}

/** Render a group of sets, each on its own line */
function renderSetItems(
	category: SetTableProps["category"],
	sets: SetRow[],
): ReturnType<typeof SetTable> {
	return (
		<>
			{sets.map((s) => (
				<div class="set-item">{formatSet(category, s)}</div>
			))}
		</>
	);
}

export function SetTable(props: SetTableProps) {
	const { category, sets } = props;
	const planned = sets.filter((s) => s.is_planned === 1);
	const actual = sets.filter((s) => s.is_planned === 0);

	const hasBoth = planned.length > 0 && actual.length > 0;

	if (sets.length === 0) {
		return <div class="set-display">-</div>;
	}

	if (hasBoth) {
		return (
			<div class="set-display set-display-comparison">
				<div class="set-planned">
					<span class="set-label">計画:</span>
					{renderSetItems(category, planned)}
				</div>
				<div class="set-actual">
					<span class="set-label">実績:</span>
					{renderSetItems(category, actual)}
				</div>
			</div>
		);
	}

	return (
		<div class="set-display">
			{renderSetItems(category, actual.length > 0 ? actual : planned)}
		</div>
	);
}
