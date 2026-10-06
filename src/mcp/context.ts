/**
 * Issue #66 Phase 4b: `/mcp` の per-request 認可コンテキスト。
 *
 * `/mcp` ではリクエストごとに access token を検証し、その token に束縛された
 * 内部 `users.id`（OAuth の props）と、DB から照会した `users.role`、token の
 * `scope` をこのコンテキストにまとめて McpServer を生成する。ツール層は
 * この値だけを見て、他ユーザーのデータへ到達しないようにする。
 */

/** 内部ユーザーのロール（`users.role`）。共有マスタの更新権限を分ける。 */
export type McpRole = "owner" | "member";

export interface McpContext {
	/** アプリ内部の `users.id`（INTEGER）。外部 IdP の `sub` ではない。 */
	userId: number;
	/** `users.role`。owner 限定ツールの判定に使う。 */
	role: McpRole;
	/** access token の検証済み scope。ツール単位の必要 scope 判定に使う。 */
	scopes: readonly string[];
}
