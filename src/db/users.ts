/**
 * ユーザー識別子の解決 (users / user_identities テーブル)。
 *
 * 外部 IdP の subject を内部 `user_id` として直接使わず、必ず
 * `user_identities` を経由して `users.id`（INTEGER）へ解決する。解決規則は
 * 決定的にし、既存ユーザーへの自動紐付けや新規ユーザーの自動作成は行わない。
 * ユーザーの追加は運用（SQL）で行う前提で、ここには解決に必要な読み書きだけを
 * 置く。
 */

/** 内部ユーザー (users テーブル) */
export interface UserRow {
	id: number;
	created_at: string;
	display_name: string | null;
	status: "active" | "disabled";
	role: "owner" | "member";
}

/** 外部 IdP 識別子の対応 (user_identities テーブル) */
export interface UserIdentityRow {
	id: number;
	user_id: number;
	provider: string;
	subject: string | null;
	email: string | null;
}

/**
 * Cloudflare Access を表す provider 名。
 * 実 subject / email の値はコードやドキュメントに埋め込まない（運用で投入する）。
 */
export const ACCESS_IDENTITY_PROVIDER = "cloudflare-access";

/**
 * 内部 `users.id` の現在の状態を返す（見つからなければ null）。
 *
 * OAuth の access token は許可リストを外した後も TTL まで有効なため、
 * `apiHandler` が毎リクエストこれで `users.status` を照会し、`disabled` なら
 * 401 にする。
 */
export async function getUserStatus(
	db: D1Database,
	userId: number,
): Promise<UserRow["status"] | null> {
	const row = await db
		.prepare("SELECT status FROM users WHERE id = ?")
		.bind(userId)
		.first<{ status: string }>();
	if (!row) return null;
	return row.status === "active" ? "active" : "disabled";
}

/** `resolveAccessIdentity` の結果。 */
export type AccessIdentityResolution =
	| { status: "resolved"; userId: number }
	| { status: "not_registered" }
	| { status: "disabled" };

/**
 * 検証済みの Cloudflare Access 識別子を内部 `users.id` に解決する。
 *
 * - `(provider, subject)` の既存リンクがあればその `users.id` を返す。
 * - 無い場合、`subject` が NULL の招待行の `email` と一致し、`users.status` が
 *   `active` なら `subject` を確定して紐付ける（確定済みの subject は上書きしない）。
 * - それ以外は未登録として扱う。既存ユーザーへの自動紐付け・自動新規作成はしない。
 * - 解決先ユーザーが `disabled` なら `disabled` を返す。
 *
 * `email` の照合は `user_identities.email` の `COLLATE NOCASE UNIQUE` に従い
 * 大文字小文字を区別しない。招待行はオーナーが許可リストとして投入したものだけを
 * 対象にするため、JWT の email は Access が認証した値として扱う。
 */
export async function resolveAccessIdentity(
	db: D1Database,
	identity: { subject: string; email?: string | null },
): Promise<AccessIdentityResolution> {
	const subject = identity.subject;
	if (!subject) return { status: "not_registered" };
	const email = identity.email?.trim() || null;

	const linked = await db
		.prepare(
			`SELECT u.id AS user_id, u.status AS status
			 FROM user_identities i
			 JOIN users u ON u.id = i.user_id
			 WHERE i.provider = ? AND i.subject = ?`,
		)
		.bind(ACCESS_IDENTITY_PROVIDER, subject)
		.first<{ user_id: number; status: string }>();

	if (linked) {
		return linked.status === "active"
			? { status: "resolved", userId: linked.user_id }
			: { status: "disabled" };
	}

	if (!email) return { status: "not_registered" };

	// 事前投入された招待行（subject 未確定）を email で照合する。
	const invite = await db
		.prepare(
			`SELECT i.id AS id, u.id AS user_id, u.status AS status
			 FROM user_identities i
			 JOIN users u ON u.id = i.user_id
			 WHERE i.provider = ? AND i.subject IS NULL AND i.email = ?`,
		)
		.bind(ACCESS_IDENTITY_PROVIDER, email)
		.first<{ id: number; user_id: number; status: string }>();

	if (!invite) return { status: "not_registered" };
	if (invite.status !== "active") return { status: "disabled" };

	// subject は NULL のときだけ確定する。既に別の subject が入っていれば触らない。
	await db
		.prepare(
			"UPDATE user_identities SET subject = ? WHERE id = ? AND subject IS NULL",
		)
		.bind(subject, invite.id)
		.run();

	// 競合で確定できなかった場合は、この subject では解決できないため未登録とする。
	const bound = await db
		.prepare(
			"SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?",
		)
		.bind(ACCESS_IDENTITY_PROVIDER, subject)
		.first<{ user_id: number }>();

	return bound
		? { status: "resolved", userId: bound.user_id }
		: { status: "not_registered" };
}
