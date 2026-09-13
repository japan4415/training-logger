import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("MCP handler", () => {
	describe("POST /mcp", () => {
		it("initialize returns a valid JSON-RPC response", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
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

		it("tools/list returns list of tools including create_feedback", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
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
			expect(toolNames).toContain("create_feedback");

			const feedbackTool = data.result.tools.find(
				(t) => t.name === "create_feedback",
			);
			expect(feedbackTool).toBeDefined();
			expect(feedbackTool?.description).toContain(
				"training-logger への機能要望・不具合報告・種目追加要望を GitHub issue として起票します",
			);
		});

		it("tools/call executes create_feedback and returns pre-filled URL when token is unset", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
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
	});

	describe("POST /mcp error handling", () => {
		it("returns a JSON-RPC error for invalid JSON body", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
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
			const response = await SELF.fetch("http://localhost/mcp", {
				method: "GET",
			});

			expect(response.status).toBe(405);
		});
	});
});
