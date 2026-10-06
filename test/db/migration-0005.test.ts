import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration0001 from "../../migrations/0001_initial_schema.sql?raw";
import migration0002 from "../../migrations/0002_atlas_muscles.sql?raw";
import migration0003 from "../../migrations/0003_atlas_trunk_muscles.sql?raw";
import migration0004 from "../../migrations/0004_session_photos.sql?raw";
import migration0005 from "../../migrations/0005_users_and_user_id.sql?raw";

/** Tables rebuilt by 0005. */
const REBUILT_TABLES = [
	"sets",
	"session_exercises",
	"session_photos",
	"workout_sessions",
] as const;

/**
 * Apply a multi-statement migration file the way wrangler does: split on ";"
 * and run every statement in one transaction (D1 batch is transactional).
 */
async function execMigration(sql: string): Promise<void> {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) =>
			statement
				.split("\n")
				.some((line) => line.trim() !== "" && !line.trim().startsWith("--")),
		);
	await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

async function dropAllTables(): Promise<void> {
	// Child before parent so the drops are valid with foreign keys enforced.
	for (const table of [
		"sets",
		"session_photos",
		"session_exercises",
		"workout_sessions",
		"exercise_aliases",
		"exercises",
		"user_identities",
		"users",
	]) {
		await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}
}

/** Recreate the 0001-0004 schema and seed one row per table. */
async function setupPreMigrationData(): Promise<void> {
	await dropAllTables();
	await execMigration(migration0001);
	await execMigration(migration0002);
	await execMigration(migration0003);
	await execMigration(migration0004);
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO exercises (id, name, category, equipment, target_muscles, notes) VALUES (?, ?, ?, ?, ?, ?)",
		).bind(1, "ウォーキング", "cardio", "トレッドミル", null, null),
		env.DB.prepare(
			"INSERT INTO exercises (id, name, category, equipment, target_muscles, notes) VALUES (?, ?, ?, ?, ?, ?)",
		).bind(
			2,
			"カイザーチェストプレス",
			"strength",
			"カイザー空圧マシン",
			null,
			null,
		),
		env.DB.prepare(
			"INSERT INTO exercise_aliases (id, exercise_id, alias) VALUES (?, ?, ?)",
		).bind(1, 2, "Keiser Chest Press"),
		// id 5 is intentionally skipped to prove id preservation, not re-numbering.
		env.DB.prepare(
			"INSERT INTO workout_sessions (id, session_date, goal, body_condition, notes) VALUES (?, ?, ?, ?, ?)",
		).bind(1, "2026-08-15", "ダイエット", "左足首・膝の怪我歴あり", "memo"),
		env.DB.prepare(
			"INSERT INTO workout_sessions (id, session_date, goal, body_condition, notes) VALUES (?, ?, ?, ?, ?)",
		).bind(2, "2026-08-16", null, null, null),
		env.DB.prepare(
			"INSERT INTO workout_sessions (id, session_date, goal, body_condition, notes) VALUES (?, ?, ?, ?, ?)",
		).bind(5, "2026-08-17", "筋力アップ", null, null),
		env.DB.prepare(
			"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(1, 1, 1, 1, "completed", null, null, null),
		env.DB.prepare(
			"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(2, 1, 2, 2, "completed", "木の台・小", "肩を下げる", "メモ"),
		env.DB.prepare(
			"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(8, 2, 1, 1, "completed", null, null, null),
		// Same exercise twice in one session: UNIQUE(session_id, display_order) must hold.
		env.DB.prepare(
			"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(16, 2, 1, 9, "completed", null, null, null),
		env.DB.prepare(
			"INSERT INTO sets (id, session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit, duration_minutes, distance_km, speed_min, speed_max, incline_percent, angle_degrees, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(1, 1, 1, 0, null, null, null, 5, null, 3.0, 3.5, 0.5, null, null),
		env.DB.prepare(
			"INSERT INTO sets (id, session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit, duration_minutes, distance_km, speed_min, speed_max, incline_percent, angle_degrees, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(
			2,
			2,
			1,
			0,
			20,
			5,
			"level",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		),
		// Planned and actual share set_order; UNIQUE(..., is_planned) must keep them apart.
		env.DB.prepare(
			"INSERT INTO sets (id, session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit, duration_minutes, distance_km, speed_min, speed_max, incline_percent, angle_degrees, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(
			3,
			2,
			1,
			1,
			20,
			5,
			"level",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		),
		env.DB.prepare(
			"INSERT INTO session_photos (id, session_id, r2_key, content_type, size_bytes) VALUES (?, ?, ?, ?, ?)",
		).bind("p1", 1, "sessions/2026-08-15/1/a.jpg", "image/jpeg", 100),
		env.DB.prepare(
			"INSERT INTO session_photos (id, session_id, r2_key, content_type, size_bytes) VALUES (?, ?, ?, ?, ?)",
		).bind("p2", 2, "sessions/2026-08-16/2/b.png", "image/png", 200),
	]);
}

async function countRows(table: string): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM ${table}`,
	).first<{ count: number }>();
	return row?.count ?? -1;
}

interface SchemaObject {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

async function schemaObjects(
	tables: readonly string[],
): Promise<SchemaObject[]> {
	const placeholders = tables.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (${placeholders}) ORDER BY type, name`,
	)
		.bind(...tables)
		.all<SchemaObject>();
	return results;
}

interface TableColumn {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

async function tableInfo(table: string): Promise<TableColumn[]> {
	const { results } = await env.DB.prepare(
		`PRAGMA table_info(${table})`,
	).all<TableColumn>();
	return results;
}

interface ForeignKey {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string;
	on_update: string;
	on_delete: string;
	match: string;
}

async function foreignKeys(table: string): Promise<ForeignKey[]> {
	const { results } = await env.DB.prepare(
		`PRAGMA foreign_key_list(${table})`,
	).all<ForeignKey>();
	return results;
}

/** Sort keys so ordering differences in the JSON output do not matter. */
function normalizeForeignKeys(keys: ForeignKey[]) {
	return [...keys]
		.map((key) => `${key.from}->${key.table}.${key.to}:${key.on_delete}`)
		.sort();
}

describe("migration 0005 (users and user data isolation)", () => {
	beforeEach(async () => {
		await setupPreMigrationData();
	});

	it("preserves every existing row and its id across the rebuilt tables", async () => {
		await execMigration(migration0005);

		const sessions = await env.DB.prepare(
			"SELECT id, user_id, session_date, goal, body_condition, notes FROM workout_sessions ORDER BY id",
		).all<{
			id: number;
			user_id: number;
			session_date: string;
			goal: string | null;
			body_condition: string | null;
			notes: string | null;
		}>();
		expect(sessions.results).toEqual([
			{
				id: 1,
				user_id: 1,
				session_date: "2026-08-15",
				goal: "ダイエット",
				body_condition: "左足首・膝の怪我歴あり",
				notes: "memo",
			},
			{
				id: 2,
				user_id: 1,
				session_date: "2026-08-16",
				goal: null,
				body_condition: null,
				notes: null,
			},
			{
				id: 5,
				user_id: 1,
				session_date: "2026-08-17",
				goal: "筋力アップ",
				body_condition: null,
				notes: null,
			},
		]);

		const sessionExercises = await env.DB.prepare(
			"SELECT id, session_id, exercise_id FROM session_exercises ORDER BY id",
		).all<{ id: number; session_id: number; exercise_id: number }>();
		expect(sessionExercises.results).toEqual([
			{ id: 1, session_id: 1, exercise_id: 1 },
			{ id: 2, session_id: 1, exercise_id: 2 },
			{ id: 8, session_id: 2, exercise_id: 1 },
			{ id: 16, session_id: 2, exercise_id: 1 },
		]);

		const sets = await env.DB.prepare(
			"SELECT id, session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit, duration_minutes, speed_min, speed_max, incline_percent FROM sets ORDER BY id",
		).all<Record<string, number | string | null>>();
		expect(sets.results).toEqual([
			{
				id: 1,
				session_exercise_id: 1,
				set_order: 1,
				is_planned: 0,
				reps: null,
				weight_value: null,
				weight_unit: null,
				duration_minutes: 5,
				speed_min: 3.0,
				speed_max: 3.5,
				incline_percent: 0.5,
			},
			{
				id: 2,
				session_exercise_id: 2,
				set_order: 1,
				is_planned: 0,
				reps: 20,
				weight_value: 5,
				weight_unit: "level",
				duration_minutes: null,
				speed_min: null,
				speed_max: null,
				incline_percent: null,
			},
			{
				id: 3,
				session_exercise_id: 2,
				set_order: 1,
				is_planned: 1,
				reps: 20,
				weight_value: 5,
				weight_unit: "level",
				duration_minutes: null,
				speed_min: null,
				speed_max: null,
				incline_percent: null,
			},
		]);

		const photos = await env.DB.prepare(
			"SELECT id, session_id, r2_key FROM session_photos ORDER BY id",
		).all<{ id: string; session_id: number; r2_key: string }>();
		expect(photos.results).toEqual([
			{ id: "p1", session_id: 1, r2_key: "sessions/2026-08-15/1/a.jpg" },
			{ id: "p2", session_id: 2, r2_key: "sessions/2026-08-16/2/b.png" },
		]);

		// The shared exercise master is not rebuilt.
		expect(await countRows("exercises")).toBe(2);
		expect(await countRows("exercise_aliases")).toBe(1);
	});

	it("keeps the original constraints, foreign keys, indexes and the exercise master", async () => {
		const beforeTables = await schemaObjects([
			...REBUILT_TABLES,
			"exercises",
			"exercise_aliases",
		]);
		const beforeSets = await tableInfo("sets");
		const beforeSessionExercises = await tableInfo("session_exercises");
		const beforePhotos = await tableInfo("session_photos");
		const beforeSetFks = normalizeForeignKeys(await foreignKeys("sets"));
		const beforeSessionExerciseFks = normalizeForeignKeys(
			await foreignKeys("session_exercises"),
		);
		const beforePhotoFks = normalizeForeignKeys(
			await foreignKeys("session_photos"),
		);

		await execMigration(migration0005);

		// No leftover *_new tables and the same named indexes exist afterwards.
		const afterTables = await schemaObjects([
			...REBUILT_TABLES,
			"exercises",
			"exercise_aliases",
		]);
		expect(
			afterTables.map((object) => `${object.type}:${object.name}`),
		).toEqual(beforeTables.map((object) => `${object.type}:${object.name}`));

		// The exercise master SQL is byte-for-byte unchanged.
		const masterBefore = beforeTables.filter((object) =>
			["exercises", "exercise_aliases"].includes(object.tbl_name),
		);
		const masterAfter = afterTables.filter((object) =>
			["exercises", "exercise_aliases"].includes(object.tbl_name),
		);
		expect(masterAfter).toEqual(masterBefore);

		// Column definitions of the child tables survive the rebuild.
		expect(await tableInfo("sets")).toEqual(beforeSets);
		expect(await tableInfo("session_exercises")).toEqual(
			beforeSessionExercises,
		);
		expect(await tableInfo("session_photos")).toEqual(beforePhotos);

		// FK targets were rewritten to the final table names and keep their actions.
		expect(normalizeForeignKeys(await foreignKeys("sets"))).toEqual(
			beforeSetFks,
		);
		expect(
			normalizeForeignKeys(await foreignKeys("session_exercises")),
		).toEqual(beforeSessionExerciseFks);
		expect(normalizeForeignKeys(await foreignKeys("session_photos"))).toEqual(
			beforePhotoFks,
		);
		expect(await foreignKeys("sets")).toContainEqual(
			expect.objectContaining({
				from: "session_exercise_id",
				on_delete: "CASCADE",
			}),
		);
		expect(await foreignKeys("session_exercises")).toContainEqual(
			expect.objectContaining({ from: "session_id", on_delete: "CASCADE" }),
		);
		expect(await foreignKeys("session_photos")).toContainEqual(
			expect.objectContaining({ from: "session_id", on_delete: "CASCADE" }),
		);

		// workout_sessions gains exactly the user_id column and the composite UNIQUE.
		const sessionColumns = await tableInfo("workout_sessions");
		expect(sessionColumns).toContainEqual(
			expect.objectContaining({
				name: "user_id",
				type: "INTEGER",
				notnull: 1,
				dflt_value: "1",
			}),
		);
		expect(
			sessionColumns.find((column) => column.name === "session_date"),
		).toMatchObject({ notnull: 1 });
		const sessionSql = afterTables.find(
			(object) => object.type === "table" && object.name === "workout_sessions",
		)?.sql;
		expect(sessionSql).toContain("UNIQUE (user_id, session_date)");
		expect(sessionSql).not.toContain("session_date TEXT NOT NULL UNIQUE");
		expect(normalizeForeignKeys(await foreignKeys("workout_sessions"))).toEqual(
			["user_id->users.id:NO ACTION"],
		);

		// Nothing is left dangling.
		const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
		expect(violations.results).toEqual([]);
	});

	it("keeps ON DELETE CASCADE working after the rebuild", async () => {
		await execMigration(migration0005);

		await env.DB.prepare("DELETE FROM workout_sessions WHERE id = ?")
			.bind(2)
			.run();
		expect(await countRows("session_exercises")).toBe(2);
		expect(await countRows("session_photos")).toBe(1);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM session_exercises WHERE session_id = 2",
			).first<{ count: number }>(),
		).toMatchObject({ count: 0 });

		await env.DB.prepare("DELETE FROM workout_sessions").run();
		expect(await countRows("session_exercises")).toBe(0);
		expect(await countRows("sets")).toBe(0);
		expect(await countRows("session_photos")).toBe(0);
		// Cascades must not touch the shared exercise master.
		expect(await countRows("exercises")).toBe(2);
	});

	it("scopes sessions per user with UNIQUE(user_id, session_date)", async () => {
		await execMigration(migration0005);

		const owner = await env.DB.prepare(
			"SELECT id, status, role FROM users ORDER BY id",
		).all<{ id: number; status: string; role: string }>();
		expect(owner.results).toEqual([{ id: 1, status: "active", role: "owner" }]);

		await env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (?, ?, ?, ?)",
		)
			.bind(2, "メンバー", "active", "member")
			.run();

		// Two users may record the same date.
		await env.DB.prepare(
			"INSERT INTO workout_sessions (user_id, session_date) VALUES (?, ?)",
		)
			.bind(2, "2026-08-15")
			.run();
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM workout_sessions WHERE session_date = ?",
			)
				.bind("2026-08-15")
				.first<{ count: number }>(),
		).toMatchObject({ count: 2 });

		// The same user cannot record the same date twice.
		await expect(
			env.DB.prepare(
				"INSERT INTO workout_sessions (user_id, session_date) VALUES (?, ?)",
			)
				.bind(2, "2026-08-15")
				.run(),
		).rejects.toThrow(/UNIQUE/i);
	});

	it("defaults user_id to the owner and keeps AUTOINCREMENT ids", async () => {
		await execMigration(migration0005);

		const inserted = await env.DB.prepare(
			"INSERT INTO workout_sessions (session_date) VALUES (?)",
		)
			.bind("2099-01-01")
			.run();
		const row = await env.DB.prepare(
			"SELECT id, user_id FROM workout_sessions WHERE id = ?",
		)
			.bind(inserted.meta.last_row_id)
			.first<{ id: number; user_id: number }>();
		expect(row).toEqual({ id: inserted.meta.last_row_id, user_id: 1 });
		// The copied ids (max 5) are preserved, so the next id continues after them.
		expect(Number(inserted.meta.last_row_id)).toBeGreaterThan(5);
	});

	it("enforces user_identities uniqueness and allows email-only invites", async () => {
		await execMigration(migration0005);

		await env.DB.prepare(
			"INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, ?, ?, ?)",
		)
			.bind(1, "cloudflare-access", "sub-owner", "Owner@Example.com")
			.run();

		await expect(
			env.DB.prepare(
				"INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, ?, ?, ?)",
			)
				.bind(1, "cloudflare-access", "sub-owner", "other@example.com")
				.run(),
		).rejects.toThrow(/UNIQUE/i);

		// email is UNIQUE COLLATE NOCASE.
		await expect(
			env.DB.prepare(
				"INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, ?, ?, ?)",
			)
				.bind(1, "cloudflare-access", "sub-other", "OWNER@EXAMPLE.COM")
				.run(),
		).rejects.toThrow(/UNIQUE/i);

		// An invite row keeps subject NULL; several may coexist for the same provider.
		await env.DB.prepare(
			"INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, ?, NULL, ?)",
		)
			.bind(1, "cloudflare-access", "invite1@example.com")
			.run();
		await env.DB.prepare(
			"INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, ?, NULL, ?)",
		)
			.bind(1, "cloudflare-access", "invite2@example.com")
			.run();
		expect(await countRows("user_identities")).toBe(3);
	});
});
