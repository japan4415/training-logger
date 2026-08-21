import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Bindings } from "../env.js";
import { createMcpServer } from "./server.js";

export const mcpApp = new Hono<{ Bindings: Bindings }>();

/**
 * POST /mcp - Streamable HTTP transport endpoint.
 *
 * Each request creates a fresh McpServer and transport (stateless).
 * enableJsonResponse: true returns plain JSON instead of SSE,
 * which is simpler and sufficient for our request-response usage.
 */
mcpApp.post("/", async (c) => {
	try {
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		const server = createMcpServer(c.env);
		await server.connect(transport);
		return transport.handleRequest(c.req.raw);
	} catch {
		return c.json(
			{
				jsonrpc: "2.0",
				error: { code: -32603, message: "Internal error" },
				id: null,
			},
			500,
		);
	}
});

/**
 * GET /mcp - Not supported.
 *
 * This server is stateless and does not provide SSE streams.
 * Per Streamable HTTP spec, servers MAY return 405 for GET.
 */
mcpApp.get("/", (c) => {
	return c.text("Method Not Allowed", 405);
});
