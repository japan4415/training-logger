import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Bindings = {
	DB: D1Database;
	PHOTOS: R2Bucket;
	/**
	 * OAuth 2.1 の grant / token / client を保存する KV namespace。
	 * `@cloudflare/workers-oauth-provider` が `OAUTH_KV` という名前で要求する。
	 */
	OAUTH_KV?: KVNamespace;
	/**
	 * OAuthProvider が fetch ディスパッチ時に注入するヘルパー。
	 * `/authorize`（defaultHandler 側）から `parseAuthRequest` などを呼ぶために使う。
	 */
	OAUTH_PROVIDER?: OAuthHelpers;
	/**
	 * `"1"` のときだけ RFC 7591 Dynamic Client Registration（`POST /oauth/register`）を有効にする。
	 * 既定は無効で、エンドポイントは 404 を返す。
	 */
	OAUTH_DCR_ENABLED?: string;
	/**
	 * OAuth の redirect_uri / CIMD client_id に許可するホストの許可リスト（カンマ区切り）。
	 * 未設定なら既定の許可リストを使う。
	 */
	OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
	/**
	 * 同意画面の CSRF トークンに使う HMAC 鍵。
	 * 必須で、未設定のときは同意フロー（GET / POST /authorize）を 503 で fail-closed にする。
	 * 例外は localhost + `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` + `ACCESS_*` 未設定の
	 * 開発フォールバックだけで、その場合のみ固定のダミー鍵を使う。
	 */
	OAUTH_CONSENT_SECRET?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED?: string;
	GITHUB_TOKEN?: string;
	GITHUB_REPO_OWNER?: string;
	GITHUB_REPO_NAME?: string;
};

/**
 * Hono context variables populated by the Cloudflare Access middleware.
 *
 * `userId` はアプリ内部の `users.id`（INTEGER）であり、外部 IdP の `sub` を
 * 直接保持しない。認証ミドルウェアが値を設定し、ハンドラ・ビュー・DB 層は
 * これだけをユーザーの識別子として使う。
 *
 * `accessSubject` は検証済み Access JWT の `sub`。OAuth 同意画面の CSRF トークンを
 * ユーザーに束縛するためにだけ使い、DB 層へは渡さない。
 *
 * `accessEmail` は検証済み Access JWT の `email`（無い場合もある）。同意画面で
 * 「どのアカウントで許可するか」を表示するためだけに使う。
 */
export type Variables = {
	userId: number;
	accessSubject?: string;
	accessEmail?: string;
};

/** Web / REST アプリ共通の Hono 環境。 */
export type AppEnv = {
	Bindings: Bindings;
	Variables: Variables;
};
