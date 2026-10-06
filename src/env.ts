export type Bindings = {
	DB: D1Database;
	PHOTOS: R2Bucket;
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
 */
export type Variables = {
	userId: number;
};

/** Web / REST アプリ共通の Hono 環境。 */
export type AppEnv = {
	Bindings: Bindings;
	Variables: Variables;
};
