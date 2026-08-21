import { Hono } from "hono";
import { registerApiRoutes } from "./api/routes.js";
import type { Bindings } from "./env.js";
import { mcpApp } from "./mcp/handler.js";
import { registerExerciseProgressRoutes } from "./views/exercise-progress.js";
import { registerExerciseListRoutes } from "./views/exercises-list.js";
import { registerSessionViews } from "./views/sessions-list.js";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.route("/mcp", mcpApp);

registerApiRoutes(app);
registerExerciseListRoutes(app);
registerExerciseProgressRoutes(app);
registerSessionViews(app);

export default app;
