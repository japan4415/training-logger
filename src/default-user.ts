/**
 * 既定オーナーの内部 `users.id`（migration 0005 で作成した `users.id = 1`）。
 *
 * Phase 3 で Web / REST の入口は Cloudflare Access の `sub` から内部 `userId` を
 * 解決し、Phase 4 で `/mcp` も OAuth の props から解決するようになった。この
 * 定数が残るのは、ローカル開発で `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` かつ
 * Host が localhost / 127.0.0.1 のときのフォールバック経路だけである。
 */
export const DEFAULT_USER_ID = 1;
