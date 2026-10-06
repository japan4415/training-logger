/**
 * Issue #66 Phase 4: 単一 Worker の `OAuthProvider` 構成。
 *
 * `/mcp` は access token 必須の API、`/authorize` は Cloudflare Access の背後に
 * 置いた同意画面、`defaultHandler` は既存の Hono アプリ。token / revocation /
 * metadata エンドポイントはライブラリが提供する。
 *
 * DCR は `clientRegistrationEndpoint` を設定しない（ライブラリ側では無効）。
 * 有効化は `OAUTH_DCR_ENABLED=1` のときだけ自前ルート（`src/oauth/dcr.ts`）で行う。
 */

import {
	OAuthProvider,
	type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { Bindings } from "../env.js";
import { mcpApiHandler } from "./api-handler.js";
import {
	ACCESS_TOKEN_TTL_SECONDS,
	AUTHORIZATION_SERVER_SCOPES,
	AUTHORIZE_ENDPOINT,
	MCP_RESOURCE,
	OAUTH_ISSUER,
	REFRESH_TOKEN_TTL_SECONDS,
	RESOURCE_REQUIRED_SCOPES,
	TOKEN_ENDPOINT,
} from "./config.js";

/** `defaultHandler` に渡す Hono アプリ。 */
export type DefaultHandler = {
	fetch: (
		request: Request,
		env: Bindings,
		ctx: ExecutionContext,
	) => Response | Promise<Response>;
};

export function createOAuthProvider(
	defaultHandler: DefaultHandler,
): OAuthProvider<Bindings> {
	// apiHandler は偽の ctx.props を渡す単体テストのために独立エクスポートしており、
	// 型はテスト向けの狭い Props（McpAuthProps）を持つ。ライブラリのオプション型は
	// Props を unknown として扱うため、ここで境界を明示的に合わせる。
	const apiHandler =
		mcpApiHandler as unknown as OAuthProviderOptions<Bindings>["apiHandler"];

	return new OAuthProvider<Bindings>({
		apiRoute: "/mcp",
		apiHandler,
		defaultHandler:
			defaultHandler as unknown as OAuthProviderOptions<Bindings>["defaultHandler"],
		authorizeEndpoint: AUTHORIZE_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,
		scopesSupported: [...AUTHORIZATION_SERVER_SCOPES],
		requiredScopes: [...RESOURCE_REQUIRED_SCOPES],
		resourceMetadata: {
			resource: MCP_RESOURCE,
			authorization_servers: [OAUTH_ISSUER],
			resource_name: "training-logger",
			bearer_methods_supported: ["header"],
		},
		clientIdMetadataDocumentEnabled: true,
		accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
		refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
		onError({ code, internal }) {
			// Authorization ヘッダやトークンはログに出さない（observability が収集するため）。
			console.error(
				`OAuth error: ${code} (${internal.category}/${internal.reason})`,
			);
		},
	});
}
