/**
 * Issue #66 Phase 4: 単一 Worker の `OAuthProvider` 構成。
 *
 * `/mcp` は access token 必須の API、`/authorize` は Cloudflare Access の背後に
 * 置いた同意画面、`defaultHandler` は既存の Hono アプリ。token / revocation /
 * metadata エンドポイントはライブラリが提供する。
 *
 * DCR は `OAUTH_DCR_ENABLED=1` のときだけライブラリの
 * `clientRegistrationEndpoint` を有効にする。`OAuthProvider` のオプションは
 * env に依存するため（AS metadata の `registration_endpoint` は静的設定でしか
 * 広告できない）、プロバイダはリクエストごとの `env` で遅延生成する。
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
	allowedRedirectHosts,
	DCR_ENDPOINT,
	isAllowedRedirectUri,
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

/** provider のオプションが依存する env（DCR の有無と redirect 許可リスト）。 */
export type OAuthConfigEnv = Pick<
	Bindings,
	"OAUTH_DCR_ENABLED" | "OAUTH_ALLOWED_REDIRECT_HOSTS"
>;

export function createOAuthProvider(
	defaultHandler: DefaultHandler,
	env: OAuthConfigEnv = {},
): OAuthProvider<Bindings> {
	return new OAuthProvider<Bindings>(oauthProviderOptions(defaultHandler, env));
}

/**
 * `OAuthProvider` のオプションを組み立てる。
 *
 * 本番の `createOAuthProvider` と、テストが `getOAuthApi` で grant / token を
 * 直接発行する経路で同じ定義を共有するために分離している。
 */
export function oauthProviderOptions(
	defaultHandler: DefaultHandler,
	env: OAuthConfigEnv = {},
): OAuthProviderOptions<Bindings> {
	// apiHandler は偽の ctx.props を渡す単体テストのために独立エクスポートしており、
	// 型はテスト向けの狭い Props（McpAuthProps）を持つ。ライブラリのオプション型は
	// Props を unknown として扱うため、ここで境界を明示的に合わせる。
	const apiHandler =
		mcpApiHandler as unknown as OAuthProviderOptions<Bindings>["apiHandler"];

	// DCR を有効にすると AS metadata に registration_endpoint が載る。無効時は
	// エンドポイントごと広告せず、/oauth/register は 404 のままにする。
	const dcr =
		env.OAUTH_DCR_ENABLED === "1"
			? dynamicClientRegistration(env.OAUTH_ALLOWED_REDIRECT_HOSTS)
			: {};

	return {
		apiRoute: "/mcp",
		apiHandler,
		defaultHandler:
			defaultHandler as unknown as OAuthProviderOptions<Bindings>["defaultHandler"],
		authorizeEndpoint: AUTHORIZE_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,
		...dcr,
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
	};
}

/**
 * DCR 有効時のオプション。ライブラリの登録エンドポイントに redirect_uri の
 * ホスト許可リストを課す（既定では `/oauth/register` を公開しない）。
 */
function dynamicClientRegistration(
	allowedHostsOverride?: string,
): Pick<
	OAuthProviderOptions<Bindings>,
	"clientRegistrationEndpoint" | "clientRegistrationCallback"
> {
	const allowed = allowedRedirectHosts(allowedHostsOverride);
	return {
		clientRegistrationEndpoint: DCR_ENDPOINT,
		clientRegistrationCallback({ clientMetadata }) {
			const redirectUris = Array.isArray(clientMetadata.redirect_uris)
				? clientMetadata.redirect_uris.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			if (
				redirectUris.length === 0 ||
				!redirectUris.every((uri) => isAllowedRedirectUri(uri, allowed))
			) {
				return {
					code: "invalid_client_metadata",
					description:
						"redirect_uris must use a host on this server's allowlist",
				};
			}
		},
	};
}
