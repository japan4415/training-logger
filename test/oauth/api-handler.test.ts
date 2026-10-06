import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_IDENTITY_PROVIDER } from "../../src/db/users.js";
import {
	type McpApiContext,
	mcpApiHandler,
} from "../../src/oauth/api-handler.js";
import { MCP_RESOURCE } from "../../src/oauth/config.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

function context(userId: unknown, scope: string[]): McpApiContext {
	return {
		props: { userId },
		auth: {
			token: "test-token",
			audience: MCP_RESOURCE,
			scope,
			userId: String(userId),
			clientId: "test-client",
		},
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as McpApiContext;
}

function callMcp(options: {
	userId?: unknown;
	scope?: string[];
	method?: string;
	body?: unknown;
}): Promise<Response> {
	const scope = options.scope ?? ["mcp:read"];
	const userId = "userId" in options ? options.userId : 1;
	return mcpApiHandler.fetch(
		new Request("http://localhost/mcp", {
			method: options.method ?? "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		}),
		env,
		context(userId, scope),
	);
}

async function seedUser(
	id: number,
	status: "active" | "disabled",
	role: "owner" | "member" = "member",
): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (?, NULL, ?, ?)",
		).bind(id, status, role),
		env.DB.prepare(
			"INSERT INTO user_identities (user_id, provider, subject) VALUES (?, ?, ?)",
		).bind(id, ACCESS_IDENTITY_PROVIDER, `subject-${id}`),
	]);
}

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "test-client", version: "1.0.0" },
	},
};

function toolCall(name: string, args: unknown, id = 2) {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	};
}

interface ToolCallResponse {
	result: { content: Array<{ text: string }>; isError?: boolean };
}

describe("/mcp apiHandler authorization", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(() => cleanDatabase(env.DB));

	it("serves an authorized initialize request", async () => {
		const response = await callMcp({ body: INITIALIZE });
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			result: { serverInfo: { name: string } };
		};
		expect(data.result.serverInfo.name).toBe("training-logger");
	});

	it("returns 403 insufficient_scope with a challenge when the baseline scope is missing", async () => {
		const response = await callMcp({
			scope: ["photos:write"],
			body: INITIALIZE,
		});
		expect(response.status).toBe(403);
		const challenge = response.headers.get("WWW-Authenticate") ?? "";
		expect(challenge).toContain('error="insufficient_scope"');
		expect(challenge).toContain('scope="mcp:read"');
		expect(challenge).toContain(
			`resource_metadata="${MCP_RESOURCE.replace("/mcp", "/.well-known/oauth-protected-resource/mcp")}"`,
		);
	});

	it("returns 401 when a disabled user's token is presented", async () => {
		await seedUser(8, "disabled");
		const response = await callMcp({ userId: 8, body: INITIALIZE });
		expect(response.status).toBe(401);
		expect((await response.json()).error).toBe("account_inactive");
	});

	it("returns 401 when the props carry no internal user id", async () => {
		const response = await callMcp({ userId: undefined, body: INITIALIZE });
		expect(response.status).toBe(401);
	});

	it("rejects non-POST requests with 405", async () => {
		const response = await callMcp({ method: "GET" });
		expect(response.status).toBe(405);
	});
});

describe("/mcp tool authorization", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(() => cleanDatabase(env.DB));

	it("returns 403 insufficient_scope when a tools/call needs a missing scope", async () => {
		const response = await callMcp({
			scope: ["mcp:read"],
			body: toolCall("log_workout", {
				date: "2026-09-14",
				exercises: [{ name: "ベンチプレス" }],
			}),
		});
		expect(response.status).toBe(403);
		const challenge = response.headers.get("WWW-Authenticate") ?? "";
		expect(challenge).toContain('error="insufficient_scope"');
		expect(challenge).toContain('scope="mcp:write"');
	});

	it("requires photos:write for the photo tools", async () => {
		const response = await callMcp({
			scope: ["mcp:read", "mcp:write"],
			body: toolCall("create_photo_upload_link", { date: "2026-09-14" }),
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate") ?? "").toContain(
			'scope="photos:write"',
		);
	});

	it("serves read-only tools with just mcp:read", async () => {
		const response = await callMcp({
			scope: ["mcp:read"],
			body: toolCall("get_history", {}),
		});
		expect(response.status).toBe(200);
	});

	it("returns a tool error when a member calls an owner-only tool", async () => {
		await seedUser(2, "active", "member");
		const response = await callMcp({
			userId: 2,
			scope: ["mcp:read", "mcp:write"],
			body: toolCall("set_exercise_muscles", {
				exercise_id: 1,
				atlas_muscles: null,
			}),
		});
		expect(response.status).toBe(200);
		const data = (await response.json()) as ToolCallResponse;
		expect(data.result.isError).toBe(true);
		expect(JSON.parse(data.result.content[0].text).error).toContain(
			"オーナーのみ",
		);
	});

	it("returns a tool error when a member registers an alias", async () => {
		await seedUser(2, "active", "member");
		const response = await callMcp({
			userId: 2,
			scope: ["mcp:read", "mcp:write"],
			body: toolCall("register_exercise", {
				name: "メンバー種目",
				aliases: ["member-alias"],
			}),
		});
		expect(response.status).toBe(200);
		const data = (await response.json()) as ToolCallResponse;
		expect(data.result.isError).toBe(true);
		expect(JSON.parse(data.result.content[0].text).error).toContain(
			"別名の登録はオーナー",
		);
	});

	it("keeps one user's logs out of another user's tool results", async () => {
		await seedUser(2, "active", "member");
		await callMcp({
			userId: 1,
			scope: ["mcp:read", "mcp:write"],
			body: toolCall("log_workout", {
				date: "2026-09-14",
				exercises: [{ name: "ベンチプレス", sets: [{ reps: 5 }] }],
			}),
		});

		const other = await callMcp({
			userId: 2,
			scope: ["mcp:read"],
			body: toolCall("get_history", {}),
		});
		expect(other.status).toBe(200);
		const otherData = (await other.json()) as ToolCallResponse;
		expect(JSON.parse(otherData.result.content[0].text).sessions).toEqual([]);

		const owner = await callMcp({
			userId: 1,
			scope: ["mcp:read"],
			body: toolCall("get_history", {}),
		});
		const ownerData = (await owner.json()) as ToolCallResponse;
		expect(JSON.parse(ownerData.result.content[0].text).sessions).toHaveLength(
			1,
		);
	});
});
