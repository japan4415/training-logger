/** 種目マスタ (exercises テーブル) */
export interface ExerciseRow {
	id: number;
	name: string;
	category: "strength" | "cardio" | "flexibility" | "other";
	equipment: string | null;
	target_muscles: string | null;
	atlas_muscles?: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

/** 種目別名 (exercise_aliases テーブル) */
export interface ExerciseAliasRow {
	id: number;
	exercise_id: number;
	alias: string;
}

/** ワークアウトセッション (workout_sessions テーブル) */
export interface WorkoutSessionRow {
	id: number;
	session_date: string;
	goal: string | null;
	body_condition: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

/** セッションに紐づく写真メタデータ (session_photos テーブル) */
export interface SessionPhotoRow {
	id: string;
	session_id: number;
	r2_key: string;
	content_type: "image/jpeg" | "image/png" | "image/webp";
	size_bytes: number;
	created_at: string;
}

/** セッション内種目実施 (session_exercises テーブル) */
export interface SessionExerciseRow {
	id: number;
	session_id: number;
	exercise_id: number;
	display_order: number;
	status: "planned" | "completed" | "skipped";
	equipment_note: string | null;
	form_cues: string | null;
	notes: string | null;
	created_at: string;
}

/** セット (sets テーブル) */
export interface SetRow {
	id: number;
	session_exercise_id: number;
	set_order: number;
	is_planned: 0 | 1;
	reps: number | null;
	weight_value: number | null;
	weight_unit: "kg" | "lbs" | "level" | null;
	duration_minutes: number | null;
	distance_km: number | null;
	speed_min: number | null;
	speed_max: number | null;
	incline_percent: number | null;
	angle_degrees: number | null;
	notes: string | null;
	created_at: string;
}
