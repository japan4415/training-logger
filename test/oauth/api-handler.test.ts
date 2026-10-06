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
): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (?, NULL, ?, 'member')",
		).bind(id, status),
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
