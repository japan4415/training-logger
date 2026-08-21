import { Hono } from "hono";
import type { Bindings } from "./env.js";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

export default app;
