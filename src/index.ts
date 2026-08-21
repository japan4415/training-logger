import { Hono } from "hono";
import type { Bindings } from "./env.js";
import { mcpApp } from "./mcp/handler.js";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.route("/mcp", mcpApp);

export default app;
