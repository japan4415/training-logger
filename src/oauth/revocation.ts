/**
 * Issue #66 Phase 4 / 設計 §10: ユーザー単位の grant 失効。
 *
 * 許可リスト（Access）を外しても発行済みの MCP トークンは TTL まで有効なため、
 * 管理者がユーザー単位で全 grant を失効させる手順をコードでも用意する。
 * ライブラリは `listUserGrants()` と `revokeGrant()` を提供するので、ここで
 * ページングして全件を失効させる。
 *
 * `userId` は `completeAuthorization` に渡した識別子（内部 `users.id` の文字列）。
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** `userId` の全 grant を失効させ、失効させた件数を返す。 */
export async function revokeAllGrantsForUser(
	oauth: OAuthHelpers,
	userId: string,
): Promise<number> {
	const grantIds: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await oauth.listUserGrants(
			userId,
			cursor ? { cursor } : undefined,
		);
		for (const grant of page.items) {
			grantIds.push(grant.id);
		}
		cursor = page.cursor;
	} while (cursor);

	for (const grantId of grantIds) {
		await oauth.revokeGrant(grantId, userId);
	}
	return grantIds.length;
}
