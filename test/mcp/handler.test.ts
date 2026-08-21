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
