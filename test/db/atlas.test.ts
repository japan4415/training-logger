import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../../src/api/routes.js";
import {
	getExerciseById,
	registerExercise,
	setExerciseAtlasMuscles,
} from "../../src/db/exercises.js";
import { getHistory, getSessionDetail } from "../../src/db/queries.js";
import { createSessionExercise } from "../../src/db/records.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import { getDefaultAtlasAssignment } from "../../src/domain/atlas.js";
import type { Bindings } from "../../src/env.js";
import {
	listAtlasMusclesHandler,
	registerExerciseHandler,
	searchExercisesHandler,
	setExerciseMusclesHandler,
} from "../../src/mcp/tools/exercises.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

const empty = { primary: [], secondary: [], unavailable: [] };
const assignment = {
	primary: ["FJ1394"],
	secondary: ["FJ1437"],
	unavailable: ["広背筋"],
};
const app = new Hono<{ Bindings: Bindings }>();
registerApiRoutes(app);

describe("Persisted Atlas assignments", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(() => cleanDatabase(env.DB));

	it("defaults known names, preserves legacy text and leaves unknown names unassigned", async () => {
		const { exercise } = await registerExercise(env.DB, {
			name: "ベンチプレス",
			target_muscles: "胸",
		});
		expect(JSON.parse(exercise.atlas_muscles ?? "null")).toEqual(
			getDefaultAtlasAssignment("ベンチプレス"),
		);
		expect(exercise.target_muscles).toBe("胸");
		const unknown = await registerExercise(env.DB, { name: "未知の種目" });
		expect(unknown.exercise.atlas_muscles).toBeNull();
	});

	it("honors explicit empty and null values instead of applying defaults", async () => {
		const first = await registerExercise(env.DB, {
			name: "ベンチプレス",
			atlas_muscles: empty,
		});
		expect(JSON.parse(first.exercise.atlas_muscles ?? "null")).toEqual(empty);
		const second = await registerExercise(env.DB, {
			name: "ウォーキング",
			atlas_muscles: null,
		});
		expect(second.exercise.atlas_muscles).toBeNull();
	});

	it("replaces, clears and resets assignments while preserving other fields", async () => {
		const { exercise } = await registerExercise(env.DB, {
			name: "テスト種目",
			target_muscles: "胸",
			notes: "keep",
		});
		const updated = await setExerciseAtlasMuscles(env.DB, exercise.id, {
			...assignment,
			secondary: ["FJ1394", "FJ1437"],
		});
		expect(JSON.parse(updated.atlas_muscles ?? "null")).toEqual(assignment);
		expect(updated.target_muscles).toBe("胸");
		expect(updated.notes).toBe("keep");
		expect(
			JSON.parse(
				(await setExerciseAtlasMuscles(env.DB, exercise.id, empty))
					.atlas_muscles ?? "null",
			),
		).toEqual(empty);
		expect(
			(await setExerciseAtlasMuscles(env.DB, exercise.id, null)).atlas_muscles,
		).toBeNull();
		await expect(
			setExerciseAtlasMuscles(env.DB, 999999, assignment),
		).rejects.toThrow("Exercise not found");
	});

	it("rejects invalid IDs before any insert or update side effects", async () => {
		const invalid = { ...empty, primary: ["FJ-does-not-exist"] };
		await expect(
			registerExercise(env.DB, {
				name: "invalid",
				aliases: ["no side effect"],
				atlas_muscles: invalid,
			}),
		).rejects.toThrow();
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) AS n FROM exercises").first<{
					n: number;
				}>()
			)?.n,
		).toBe(0);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM exercise_aliases",
				).first<{ n: number }>()
			)?.n,
		).toBe(0);
		const { exercise } = await registerExercise(env.DB, {
			name: "valid",
			atlas_muscles: assignment,
		});
		await expect(
			setExerciseAtlasMuscles(env.DB, exercise.id, invalid),
		).rejects.toThrow();
		expect(await getExerciseById(env.DB, exercise.id)).toEqual(exercise);
	});

	it("carries assignments through session and history JOINs", async () => {
		const { exercise } = await registerExercise(env.DB, {
			name: "JOIN test",
			atlas_muscles: assignment,
		});
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-10",
		});
		await createSessionExercise(env.DB, {
			sessionId: session.id,
			exerciseId: exercise.id,
		});
		const detail = await getSessionDetail(env.DB, session.id);
		expect(
			JSON.parse(detail?.exercises[0].exercise.atlas_muscles ?? "null"),
		).toEqual(assignment);
		const history = await getHistory(env.DB, { includeSets: false });
		expect(
			JSON.parse(history[0].exercises[0].exercise.atlas_muscles ?? "null"),
		).toEqual(assignment);
	});

	it("returns decoded assignments consistently from MCP registration, mutation and search", async () => {
		const registered = await registerExerciseHandler(env, {
			name: "MCP test",
			atlas_muscles: assignment,
		});
		expect(registered.exercise.atlas_muscles).toEqual(assignment);
		const result = await setExerciseMusclesHandler(env, {
			exercise_id: registered.exercise.id,
			atlas_muscles: empty,
		});
		expect(result.exercise.atlas_muscles).toEqual(empty);
		expect(
			(await searchExercisesHandler(env, { query: "MCP test" })).exercises[0]
				.atlas_muscles,
		).toEqual(empty);
		await setExerciseMusclesHandler(env, {
			exercise_id: registered.exercise.id,
			atlas_muscles: null,
		});
		expect(
			(await searchExercisesHandler(env, {})).exercises[0].atlas_muscles,
		).toBeNull();
	});

	it("searches the muscle catalog by exact ID, Japanese or English without unknown matches", () => {
		expect(
			listAtlasMusclesHandler({ query: " FJ1394 " }).muscles.map((m) => m.id),
		).toEqual(["FJ1394", "FJ1394M"]);
		expect(
			listAtlasMusclesHandler({ query: "腓腹筋" }).muscles.length,
		).toBeGreaterThan(0);
		expect(
			listAtlasMusclesHandler({ query: "GASTROCNEMIUS" }).muscles.length,
		).toBeGreaterThan(0);
		expect(listAtlasMusclesHandler({ query: "__proto__" }).muscles).toEqual([]);
	});

	it.each([assignment, empty, null])(
		"returns decoded Atlas data from both exercise REST endpoints: %j",
		async (value) => {
			const { exercise } = await registerExercise(env.DB, {
				name: "API test",
				atlas_muscles: value,
			});
			const list = await app.request("/api/exercises", {}, env);
			expect(list.status).toBe(200);
			expect(
				(await list.json<{ exercises: { atlas_muscles: unknown }[] }>())
					.exercises[0].atlas_muscles,
			).toEqual(value);
			const detail = await app.request(
				`/api/exercises/${exercise.id}`,
				{},
				env,
			);
			expect(
				(await detail.json<{ exercise: { atlas_muscles: unknown } }>()).exercise
					.atlas_muscles,
			).toEqual(value);
		},
	);
});
