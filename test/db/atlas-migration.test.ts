import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import migration from "../../migrations/0002_atlas_muscles.sql?raw";
import profiles from "../../src/domain/atlas-profiles.json";

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
	const statements = migration
		.replaceAll(/\bexercises\b/g, "atlas_migration_exercises")
		.split(";")
		.map((sql) => sql.trim())
		.filter(Boolean);
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
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
