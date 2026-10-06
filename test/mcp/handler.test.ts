import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	listSessionPhotos,
	PHOTO_MAX_BASE64_CHARS,
	PHOTO_MAX_BYTES,
} from "../../src/db/session-photos.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import {
	type McpApiContext,
	mcpApiHandler,
} from "../../src/oauth/api-handler.js";
import { MCP_RESOURCE } from "../../src/oauth/config.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";
import { photoBase64, photoBytes } from "../fixtures/photos.js";

const PNG_BASE64 = "iVBORw0KGgo=";

/** `/mcp` の apiHandler を、OAuth ライブラリを通さず偽の ctx で直接呼ぶ。 */
function mcpContext(
	userId: number,
	scope: string[] = ["mcp:read", "mcp:write", "photos:write"],
): McpApiContext {
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

function mcpFetch(
	init: RequestInit,
	userId = 1,
	scope: string[] = ["mcp:read", "mcp:write", "photos:write"],
): Promise<Response> {
	return mcpApiHandler.fetch(
		new Request("http://localhost/mcp", init),
		env,
		mcpContext(userId, scope),
	);
}

describe("MCP handler", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(async () => {
		await cleanDatabase(env.DB);
		const listed = await env.PHOTOS.list();
		if (listed.objects.length) {
			await env.PHOTOS.delete(listed.objects.map((object) => object.key));
		}
	});

	describe("POST /mcp", () => {
		it("initialize returns a valid JSON-RPC response", async () => {
			const response = await mcpFetch({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: {
							name: "test-client",
							version: "1.0.0",
						},
					},
				}),
			});

			expect(response.status).toBe(200);

			const data = (await response.json()) as {
				jsonrpc: string;
				id: number;
				result: {
					protocolVersion: string;
					capabilities: Record<string, unknown>;
					serverInfo: { name: string; version: string };
				};
			};

			expect(data.jsonrpc).toBe("2.0");
			expect(data.id).toBe(1);
			expect(data.result).toBeDefined();
			expect(data.result.serverInfo.name).toBe("training-logger");
			expect(data.result.serverInfo.version).toBe("0.1.0");
			expect(data.result.protocolVersion).toBe("2025-11-25");
		});

		it("tools/list returns all 11 tools", async () => {
			const response = await mcpFetch({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {},
				}),
			});

			expect(response.status).toBe(200);

			const data = (await response.json()) as {
				jsonrpc: string;
				id: number;
				result: {
					tools: Array<{
						name: string;
						description: string;
						inputSchema: Record<string, unknown>;
					}>;
				};
			};

			expect(data.jsonrpc).toBe("2.0");
			expect(data.id).toBe(2);
			expect(data.result).toBeDefined();
			expect(data.result.tools).toBeInstanceOf(Array);

			const toolNames = data.result.tools.map((t) => t.name);
			expect(toolNames).toHaveLength(11);
			expect(toolNames).toContain("create_feedback");
			expect(toolNames).toContain("create_photo_upload_link");
			expect(toolNames).toContain("upload_session_photo");

			const feedbackTool = data.result.tools.find(
				(t) => t.name === "create_feedback",
			);
			expect(feedbackTool).toBeDefined();
			expect(feedbackTool?.description).toContain(
				"training-logger への機能要望・不具合報告・種目追加要望を GitHub issue として起票します",
			);

			const uploadTool = data.result.tools.find(
				(t) => t.name === "upload_session_photo",
			);
			expect(uploadTool?.description).toContain(
				"Claude Code などローカルファイルを読める環境向けです",
			);
			expect(uploadTool?.inputSchema).toMatchObject({
				required: ["date", "data_base64"],
				properties: {
					data_base64: {
						minLength: 1,
					},
					content_type: {
						enum: ["image/jpeg", "image/png", "image/webp"],
					},
				},
			});
			expect(uploadTool?.inputSchema).not.toHaveProperty(
				"properties.data_base64.maxLength",
			);
		});

		it("tools/call executes create_feedback and returns pre-filled URL when token is unset", async () => {
			const response = await mcpFetch({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "create_feedback",
						arguments: {
							title: "テスト要望",
							body: "テスト内容",
						},
					},
				}),
			});

			expect(response.status).toBe(200);

			const data = (await response.json()) as {
				jsonrpc: string;
				id: number;
				result: {
					content: Array<{ type: string; text: string }>;
					isError?: boolean;
				};
			};

			expect(data.jsonrpc).toBe("2.0");
			expect(data.id).toBe(3);
			expect(data.result.isError).toBe(true);
			const parsed = JSON.parse(data.result.content[0].text);
			expect(parsed.manual_url).toContain(
				"https://github.com/japan4415/training-logger/issues/new?",
			);
			expect(parsed.manual_url).toContain(
				"title=%E3%83%86%E3%82%B9%E3%83%88%E8%A6%81%E6%9C%9B",
			);
		});

		it("tools/call stores a session photo and returns JSON content", async () => {
			const { session } = await getOrCreateSession(env.DB, 1, {
				sessionDate: "2026-09-14",
			});
			const response = await mcpFetch({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: {
						name: "upload_session_photo",
						arguments: {
							date: "2026-09-14",
							data_base64: PNG_BASE64,
							content_type: "image/png",
						},
					},
				}),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				jsonrpc: string;
				id: number;
				result: {
					content: Array<{ type: string; text: string }>;
					isError?: boolean;
				};
			};
			expect(data.result.isError).toBeUndefined();
			expect(JSON.parse(data.result.content[0].text)).toMatchObject({
				session_id: session.id,
				date: "2026-09-14",
				content_type: "image/png",
				size_bytes: 8,
			});
			expect(await listSessionPhotos(env.DB, 1, session.id)).toHaveLength(1);
		});

		it.each([392908, 382181, 918483, 789743, 912749, 820855, PHOTO_MAX_BYTES])(
			"stores %i bytes through JSON-RPC and R2 without altering the photo",
			async (size) => {
				const { session } = await getOrCreateSession(env.DB, 1, {
					sessionDate: "2026-09-14",
				});
				const bytes = photoBytes(size);
				const response = await mcpFetch({
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 6,
						method: "tools/call",
						params: {
							name: "upload_session_photo",
							arguments: {
								date: "2026-09-14",
								data_base64: photoBase64(bytes),
							},
						},
					}),
				});
				expect(response.status).toBe(200);
				const data = (await response.json()) as {
					result: { content: Array<{ text: string }>; isError?: boolean };
				};
				expect(data.result.isError).toBeUndefined();
				expect(JSON.parse(data.result.content[0].text)).toMatchObject({
					session_id: session.id,
					size_bytes: size,
					content_type: "image/jpeg",
				});
				const photos = await listSessionPhotos(env.DB, 1, session.id);
				expect(photos).toHaveLength(1);
				const object = await env.PHOTOS.get(photos[0].r2_key);
				expect(object).not.toBeNull();
				if (!object) throw new Error("Stored photo was not found in R2");
				const storedBytes = await object.arrayBuffer();
				expect(await crypto.subtle.digest("SHA-256", storedBytes)).toEqual(
					await crypto.subtle.digest("SHA-256", bytes),
				);
			},
		);

		it("tools/call returns invalid_base64 when data exceeds the character limit", async () => {
			await getOrCreateSession(env.DB, 1, { sessionDate: "2026-09-14" });
			const response = await mcpFetch({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 5,
					method: "tools/call",
					params: {
						name: "upload_session_photo",
						arguments: {
							date: "2026-09-14",
							data_base64: "A".repeat(PHOTO_MAX_BASE64_CHARS + 1),
						},
					},
				}),
			});

			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				result: {
					content: Array<{ type: string; text: string }>;
					isError?: boolean;
				};
			};
			expect(data.result.isError).toBe(true);
			expect(JSON.parse(data.result.content[0].text)).toMatchObject({
				isError: true,
				error: "invalid_base64",
				message: expect.any(String),
			});
		});
	});

	describe("POST /mcp error handling", () => {
		it("returns a JSON-RPC error for invalid JSON body", async () => {
			const response = await mcpFetch({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: "{ not valid json",
			});

			const data = (await response.json()) as {
				jsonrpc: string;
				error: { code: number; message: string };
				id: null;
			};

			expect(data.jsonrpc).toBe("2.0");
			expect(data.error).toBeDefined();
			expect(data.error.code).toBeLessThan(0);
			expect(data.id).toBeNull();
		});
	});

	describe("GET /mcp", () => {
		it("returns 405 Method Not Allowed", async () => {
			const response = await mcpFetch({
				method: "GET",
			});

			expect(response.status).toBe(405);
		});
	});
});

/** ツール呼び出しを JSON-RPC で組み立てる（apiHandler を直接呼ぶ）。 */
function toolFetch(
	name: string,
	args: unknown,
	userId = 1,
	scope: string[] = ["mcp:read", "mcp:write", "photos:write"],
): Promise<Response> {
	return mcpFetch(
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		},
		userId,
		scope,
	);
}

async function toolText(response: Response): Promise<unknown> {
	expect(response.status).toBe(200);
	const data = (await response.json()) as {
		result: { content: Array<{ text: string }>; isError?: boolean };
	};
	expect(data.result.isError).toBeUndefined();
	return JSON.parse(data.result.content[0].text);
}

describe("MCP authorization", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(async () => {
		await cleanDatabase(env.DB);
		const listed = await env.PHOTOS.list();
		if (listed.objects.length) {
			await env.PHOTOS.delete(listed.objects.map((object) => object.key));
		}
	});

	it("does not leak another user's history through get_history", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (2, NULL, 'active', 'member')",
		).run();

		await toolFetch("log_workout", {
			date: "2026-09-14",
			exercises: [{ name: "ベンチプレス", sets: [{ reps: 5 }] }],
		});

		const other = (await toolText(
			await toolFetch("get_history", {}, 2, ["mcp:read"]),
		)) as { sessions: unknown[] };
		expect(other.sessions).toEqual([]);

		const owner = (await toolText(
			await toolFetch("get_history", {}, 1, ["mcp:read"]),
		)) as { sessions: unknown[] };
		expect(owner.sessions).toHaveLength(1);
	});

	it("rejects an owner-only tool for a member with a tool error", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (2, NULL, 'active', 'member')",
		).run();
		const response = await toolFetch(
			"set_exercise_muscles",
			{ exercise_id: 1, atlas_muscles: null },
			2,
			["mcp:read", "mcp:write"],
		);
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			result: { content: Array<{ text: string }>; isError?: boolean };
		};
		expect(data.result.isError).toBe(true);
		expect(JSON.parse(data.result.content[0].text).error).toContain(
			"オーナーのみ",
		);
	});

	it("returns 403 insufficient_scope when the tool needs a missing scope", async () => {
		const response = await toolFetch(
			"log_workout",
			{ date: "2026-09-14", exercises: [{ name: "ベンチプレス" }] },
			1,
			["mcp:read"],
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate") ?? "").toContain(
			'scope="mcp:write"',
		);
	});

	it("scopes the photo link and upload to the caller's session", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, display_name, status, role) VALUES (2, NULL, 'active', 'member')",
		).run();
		await getOrCreateSession(env.DB, 1, { sessionDate: "2026-09-14" });

		const link = (await toolText(
			await toolFetch("create_photo_upload_link", { date: "2026-09-14" }),
		)) as { session_id: number; url: string };
		expect(link.session_id).toBeGreaterThan(0);
		expect(link.url).toContain(`/sessions/${link.session_id}`);

		// 他ユーザーは同じ日付でも自分のセッションが無いためリンクを発行できない。
		const denied = await toolFetch(
			"create_photo_upload_link",
			{ date: "2026-09-14" },
			2,
		);
		expect(denied.status).toBe(200);
		const deniedData = (await denied.json()) as {
			result: { content: Array<{ text: string }>; isError?: boolean };
		};
		expect(deniedData.result.isError).toBe(true);
	});
});
