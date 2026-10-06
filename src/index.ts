import { Hono } from "hono";
import { registerApiRoutes } from "./api/routes.js";
import type { AppEnv, Bindings } from "./env.js";
import { registerAuthorizeRoutes } from "./oauth/authorize.js";
import { createOAuthProvider } from "./oauth/provider.js";
import { registerAccessAuth } from "./security/auth.js";
import { registerExerciseProgressRoutes } from "./views/exercise-progress.js";
import { registerExerciseListRoutes } from "./views/exercises-list.js";
import { registerSessionViews } from "./views/sessions-list.js";

const app = new Hono<AppEnv>();

// deny-by-default の Cloudflare Access 認証（公開パス以外は JWT 必須）。
// ルート登録より前に置き、未認証リクエストがハンドラへ届かないようにする。
// `/authorize` は保護されたまま（Access JWT 必須）で、OAuth の token / metadata /
// 登録エンドポイントは公開パスとして扱う。
registerAccessAuth(app);

app.get("/health", (c) => c.json({ status: "ok" }));

registerApiRoutes(app);
registerExerciseListRoutes(app);
registerExerciseProgressRoutes(app);
registerSessionViews(app);
registerAuthorizeRoutes(app);

// `/mcp` は OAuthProvider が access token を検証してから apiHandler へ渡す。
// それ以外のリクエストは defaultHandler（この Hono アプリ）へ流れる。
// provider のオプションは DCR の有無など env に依存する（AS metadata の
// `registration_endpoint` は静的設定でしか広告できない）ため、env ごとに遅延生成する。
const providers = new WeakMap<
	Bindings,
	ReturnType<typeof createOAuthProvider>
>();

function oauthProvider(env: Bindings): ReturnType<typeof createOAuthProvider> {
	let provider = providers.get(env);
	if (!provider) {
		provider = createOAuthProvider(app, env);
		providers.set(env, provider);
	}
	return provider;
}

export default {
	fetch(
		request: Request,
		env: Bindings,
		ctx: ExecutionContext,
	): Promise<Response> {
		return oauthProvider(env).fetch(request, env, ctx);
	},
};
