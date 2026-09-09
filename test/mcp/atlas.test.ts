import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExercise } from "../../src/db/exercises.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

async function rpc(method: string, params = {}) {
	const response = await SELF.fetch("http://localhost/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	expect(response.status).toBe(200);
	return response.json<{
		result: {
			tools?: { name: string }[];
			content?: { text: string }[];
			isError?: boolean;
		};
		error?: unknown;
	}>();
}

describe("Atlas MCP tools", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(() => cleanDatabase(env.DB));

	it("publishes both tools and searches real muscle IDs through MCP", async () => {
		const listed = await rpc("tools/list");
		expect(listed.result.tools?.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["list_atlas_muscles", "set_exercise_muscles"]),
		);
		const result = await rpc("tools/call", {
			name: "list_atlas_muscles",
			arguments: { query: "FJ1394" },
		});
		expect(result.error).toBeUndefined();
		expect(
			JSON.parse(result.result.content?.[0].text ?? "{}").muscles.map(
				(m: { id: string }) => m.id,
			),
		).toEqual(["FJ1394", "FJ1394M"]);
	});

	it("updates exact IDs and returns tool errors for invalid IDs without overwriting", async () => {
		const { exercise } = await registerExercise(env.DB, {
			name: "RPC test",
			atlas_muscles: null,
		});
		const atlas_muscles = {
			primary: ["FJ1394"],
			secondary: [],
			unavailable: [],
		};
		const result = await rpc("tools/call", {
			name: "set_exercise_muscles",
			arguments: { exercise_id: exercise.id, atlas_muscles },
		});
		expect(result.result.isError).not.toBe(true);
		expect(
			JSON.parse(result.result.content?.[0].text ?? "{}").exercise
				.atlas_muscles,
		).toEqual(atlas_muscles);
		const invalid = await rpc("tools/call", {
			name: "set_exercise_muscles",
			arguments: {
				exercise_id: exercise.id,
				atlas_muscles: { ...atlas_muscles, primary: ["unknown"] },
			},
		});
		expect(invalid.result.isError).toBe(true);
		expect(
			(
				await env.DB.prepare("SELECT atlas_muscles FROM exercises WHERE id = ?")
					.bind(exercise.id)
					.first<{ atlas_muscles: string }>()
			)?.atlas_muscles,
		).toBe(JSON.stringify(atlas_muscles));
	});
});
