import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import migration from "../../migrations/0002_atlas_muscles.sql?raw";
import trunkMigration from "../../migrations/0003_atlas_trunk_muscles.sql?raw";
import profiles from "../../src/domain/atlas-profiles.json";

async function applyMigration(sql: string, table: string) {
	const statements = sql
		.replaceAll(/\bexercises\b/g, table)
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

it("backfills all reviewed exercise aliases without changing legacy text or unknown exercises", async () => {
	// An isolated pre-migration table lets the real SQL run without the test helper's new schema.
	await env.DB.prepare(
		"CREATE TABLE atlas_migration_exercises (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE UNIQUE, target_muscles TEXT)",
	).run();
	const names = profiles.flatMap((profile) => profile.names);
	await env.DB.batch(
		[...names, "未知の種目"].map((name) =>
			env.DB.prepare(
				"INSERT INTO atlas_migration_exercises (name, target_muscles) VALUES (?, ?)",
			).bind(name, "元の部位・心肺"),
		),
	);
	await applyMigration(migration, "atlas_migration_exercises");
	await applyMigration(trunkMigration, "atlas_migration_exercises");
	const { results } = await env.DB.prepare(
		"SELECT name, target_muscles, atlas_muscles FROM atlas_migration_exercises",
	).all<{
		name: string;
		target_muscles: string;
		atlas_muscles: string | null;
	}>();
	for (const row of results) {
		expect(row.target_muscles).toBe("元の部位・心肺");
		const profile = profiles.find((p) => p.names.includes(row.name));
		expect(JSON.parse(row.atlas_muscles ?? "null")).toEqual(
			profile?.assignment ?? null,
		);
	}
	await expect(
		env.DB.prepare(
			"UPDATE atlas_migration_exercises SET atlas_muscles = ? WHERE name = ?",
		)
			.bind("not-json", "未知の種目")
			.run(),
	).rejects.toThrow();
});

it("upgrades semantically unchanged old defaults and preserves every custom assignment", async () => {
	const table = "atlas_trunk_migration_exercises";
	await env.DB.prepare(
		`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, target_muscles TEXT)`,
	).run();
	const names = [
		"ラットプルダウン",
		"Lat Pulldown",
		"シーテッドロウ",
		"Seated Row",
		"レッグレイズ",
		"Leg Raise",
	];
	await env.DB.batch(
		names.map((name) =>
			env.DB.prepare(
				`INSERT INTO ${table} (name, target_muscles) VALUES (?, ?)`,
			).bind(name, "旧テキスト・保持"),
		),
	);
	await applyMigration(migration, table);
	const { results: originals } = await env.DB.prepare(
		`SELECT id, name, atlas_muscles FROM ${table}`,
	).all<{
		id: number;
		name: string;
		atlas_muscles: string;
	}>();
	for (const row of originals) {
		const old = JSON.parse(row.atlas_muscles);
		// Reordering keys and selections must not make an untouched assignment look custom.
		const equivalent = JSON.stringify(
			{
				unavailable: old.unavailable.toReversed(),
				secondary: old.secondary.toReversed(),
				primary: old.primary.toReversed(),
			},
			null,
			2,
		);
		await env.DB.prepare(`UPDATE ${table} SET atlas_muscles = ? WHERE id = ?`)
			.bind(equivalent, row.id)
			.run();
	}
	const preserved: { name: string; value: string | null }[] = [];
	for (const row of originals) {
		const old = JSON.parse(row.atlas_muscles);
		for (const value of [
			null,
			JSON.stringify({ primary: [], secondary: [], unavailable: [] }),
			JSON.stringify({ ...old, primary: [...old.primary, "FJ1394"] }),
			JSON.stringify({ ...old, secondary: old.secondary.slice(1) }),
			JSON.stringify({
				...old,
				unavailable: [...old.unavailable, "個別の筋肉"],
			}),
		])
			preserved.push({ name: row.name, value });
	}
	preserved.push({ name: "独自のプル種目", value: originals[0].atlas_muscles });
	const inserted: { id: number; value: string | null }[] = [];
	for (const row of preserved) {
		const result = await env.DB.prepare(
			`INSERT INTO ${table} (name, target_muscles, atlas_muscles) VALUES (?, ?, ?)`,
		)
			.bind(row.name, "旧テキスト・保持", row.value)
			.run();
		inserted.push({ id: result.meta.last_row_id, value: row.value });
	}
	await applyMigration(trunkMigration, table);
	for (const row of originals) {
		const updated = await env.DB.prepare(
			`SELECT atlas_muscles FROM ${table} WHERE id = ?`,
		)
			.bind(row.id)
			.first<{ atlas_muscles: string }>();
		expect(JSON.parse(updated?.atlas_muscles ?? "null"), row.name).toEqual(
			profiles.find((profile) => profile.names.includes(row.name))?.assignment,
		);
	}
	for (const row of inserted) {
		const updated = await env.DB.prepare(
			`SELECT atlas_muscles FROM ${table} WHERE id = ?`,
		)
			.bind(row.id)
			.first<{ atlas_muscles: string | null }>();
		expect(updated?.atlas_muscles, `custom assignment ${row.id}`).toBe(
			row.value,
		);
	}
	const changedLegacy = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM ${table} WHERE target_muscles != ?`,
	)
		.bind("旧テキスト・保持")
		.first<{ count: number }>();
	expect(changedLegacy?.count).toBe(0);
	// The data update is safe to retry and leaves already migrated defaults intact.
	const before = await env.DB.prepare(
		`SELECT * FROM ${table} ORDER BY id`,
	).all();
	await applyMigration(trunkMigration, table);
	expect(
		(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results,
	).toEqual(before.results);
});
