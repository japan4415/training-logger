/**
 * Issue #66 Phase 4: OAuth 2.1 認可サーバー（MCP）の固定設定。
 *
 * MCP クライアント（ChatGPT / claude.ai など）は `resource` と認可サーバーの
 * issuer を完全一致で照合するため、ここでは本番の公開ホストを定数として持つ。
 * `OAuthProvider` のオプションはモジュール読み込み時に確定する必要があり、
 * リクエストごとの `env` では差し替えられない。ホストを変える場合はこの定数を
 * 変更してデプロイする。
 */

/** 公開ホストのオリジン。issuer / authorization_servers として使う。 */
export const OAUTH_ISSUER = "https://training-logger.discord.jp";

/** MCP の protected resource 識別子（末尾スラッシュなし）。access token の audience。 */
export const MCP_RESOURCE = `${OAUTH_ISSUER}/mcp`;

/** アプリが実装する認可エンドポイント（パス）。 */
export const AUTHORIZE_ENDPOINT = "/authorize";

/** ライブラリが実装するトークン / 失効エンドポイント（パス）。 */
export const TOKEN_ENDPOINT = "/oauth/token";

/**
 * 動的クライアント登録（RFC 7591）のエンドポイント（パス）。
 * `OAUTH_DCR_ENABLED=1` のときだけ `OAuthProvider` の
 * `clientRegistrationEndpoint` に設定し、AS metadata で広告する。
 */
export const DCR_ENDPOINT = "/oauth/register";

/**
 * 認可サーバーが発行し得るスコープの全体（AS metadata の `scopes_supported`）。
 * `offline_access` は AS metadata にだけ載せ、PRM と `WWW-Authenticate` の
 * `scope` には載せない（MCP 仕様の SHOULD NOT）。
 */
export const AUTHORIZATION_SERVER_SCOPES = [
	"mcp:read",
	"mcp:write",
	"photos:write",
	"offline_access",
] as const;

/**
 * protected resource が要求する最小スコープ（PRM の `scopes_supported`）。
 * MCP クライアントはこの値を最初に要求し、追加分は step-up で取得する。
 */
export const RESOURCE_REQUIRED_SCOPES = ["mcp:read"] as const;

/** アクセストークン TTL（秒）。既定どおり 1 時間。 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** リフレッシュトークン（grant）の寿命（秒）。30 日。使用時に回転する。 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * redirect_uri / CIMD client_id に許可するホストの既定許可リスト。
 * 実機 PoC で確定するまでの暫定で、`OAUTH_ALLOWED_REDIRECT_HOSTS` で差し替えられる。
 */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS = [
	"chatgpt.com",
	"claude.ai",
	"claude.com",
] as const;

/** 許可リストを解決する。env 上書きはカンマ区切り（前後の空白は無視）。 */
export function allowedRedirectHosts(override?: string): Set<string> {
	const hosts = override
		?.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter((host) => host.length > 0);
	if (!hosts || hosts.length === 0) {
		return new Set(DEFAULT_ALLOWED_REDIRECT_HOSTS);
	}
	return new Set(hosts);
}

/**
 * 認可リクエストの接続先ホストが許可リストに載っているか。
 *
 * トークンの送り先である `redirect_uri` のホストを第一の境界とし、CIMD の
 * `client_id` が URL の場合はそのホストも許可リストで判定する。どちらも
 * HTTPS（もしくは許可リストに載ったホスト）でなければ拒否する。
 */
export function isAllowedRedirectUri(
	redirectUri: string,
	allowed: Set<string>,
): boolean {
	let url: URL;
	try {
		url = new URL(redirectUri);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	return allowed.has(url.hostname.toLowerCase());
}

/** 認可リクエストの client_id を CIMD URL とみなしてホストを返す（URL でなければ null）。 */
export function clientIdMetadataHost(clientId: string): string | null {
	let url: URL;
	try {
		url = new URL(clientId);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	return url.hostname.toLowerCase();
}

/** 認可リクエストが許可リストに適合するか（redirect_uri のホスト or CIMD client_id のホスト）。 */
export function isAllowedAuthorizationRequest(
	request: { clientId: string; redirectUri: string },
	allowed: Set<string>,
): boolean {
	if (isAllowedRedirectUri(request.redirectUri, allowed)) return true;
	const clientHost = clientIdMetadataHost(request.clientId);
	return clientHost !== null && allowed.has(clientHost);
}
