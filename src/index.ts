import { Hono } from "hono";
import { registerApiRoutes } from "./api/routes.js";
import type { AppEnv } from "./env.js";
import { mcpApp } from "./mcp/handler.js";
import { registerAccessAuth } from "./security/auth.js";
import { registerExerciseProgressRoutes } from "./views/exercise-progress.js";
import { registerExerciseListRoutes } from "./views/exercises-list.js";
import { registerSessionViews } from "./views/sessions-list.js";

const app = new Hono<AppEnv>();

// deny-by-default の Cloudflare Access 認証（公開パス以外は JWT 必須）。
// ルート登録より前に置き、未認証リクエストがハンドラへ届かないようにする。
registerAccessAuth(app);

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.route("/mcp", mcpApp);

registerApiRoutes(app);
registerExerciseListRoutes(app);
registerExerciseProgressRoutes(app);
registerSessionViews(app);

export default app;
