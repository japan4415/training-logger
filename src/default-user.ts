/**
 * Phase 2 の暫定既定ユーザー。
 *
 * Web / MCP / API の入口はまだ認証を導入していないため、リポジトリ層へ渡す
 * `userId` はこの 1 箇所の定数に集約する（migration 0005 で作成した既定オーナー
 * `users.id = 1` に対応する）。Phase 3 以降で Cloudflare Access の `sub` から
 * 内部 `userId` を解決する実装へ置き換える。
 */
export const DEFAULT_USER_ID = 1;
