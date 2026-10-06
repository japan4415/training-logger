/**
 * Issue #66 Phase 4b: MCP ツールごとの必要スコープ（最小権限）。
 *
 * ツール単位の step-up を可能にするため、ツール名から必要 scope を一意に決める。
 * `apiHandler` はこの表を使って `tools/call` の scope 不足を HTTP 403
 * `insufficient_scope` で返し、ツール層も同じ表で二重に検査する。
 *
 * 読み取り系は `mcp:read`、書き込み系は `mcp:write`、写真系は `photos:write`。
 * `mcp:write` は `mcp:read` を含意しない（個別に要求する）。
 */

export type McpScope = "mcp:read" | "mcp:write" | "photos:write";

export const TOOL_SCOPES: Readonly<Record<string, McpScope>> = {
	// 読み取り専用ツール
	get_history: "mcp:read",
	search_exercises: "mcp:read",
	list_atlas_muscles: "mcp:read",
	// ユーザーデータ / 共有マスタを書き換えるツール
	log_workout: "mcp:write",
	update_workout: "mcp:write",
	delete_workout: "mcp:write",
	register_exercise: "mcp:write",
	set_exercise_muscles: "mcp:write",
	create_feedback: "mcp:write",
	// セッション写真を書き込むツール
	create_photo_upload_link: "photos:write",
	upload_session_photo: "photos:write",
};

/** ツール名から必要 scope を返す（未登録のツールは null）。 */
export function requiredToolScope(toolName: string): McpScope | null {
	return TOOL_SCOPES[toolName] ?? null;
}

function collectRequiredScopes(body: unknown, into: Set<McpScope>): void {
	if (Array.isArray(body)) {
		// バッチは含まれる `tools/call` をすべて検査し、必要 scope を漏らさず集める。
		for (const item of body) {
			collectRequiredScopes(item, into);
		}
		return;
	}
	if (typeof body !== "object" || body === null) return;

	const request = body as {
		method?: unknown;
		params?: { name?: unknown } | null;
	};
	if (request.method !== "tools/call") return;
	const name = request.params?.name;
	if (typeof name !== "string") return;
	const scope = requiredToolScope(name);
	if (scope) into.add(scope);
}

/**
 * JSON-RPC リクエストボディから `tools/call` の必要 scope を重複なく返す。
 *
 * バッチリクエスト（配列）は含まれる `tools/call` をすべて検査する。最初の 1 件だけを
 * 返すと後続の不足 scope が challenge に載らず step-up が不完全になるため、全件を
 * 集約する。`tools/list` / `initialize` など scope が不要なものは空配列。
 * パースできないボディでは何も要求しない（transport 側が JSON エラーを返す）。
 */
export function requiredScopesForBody(body: unknown): McpScope[] {
	const scopes = new Set<McpScope>();
	collectRequiredScopes(body, scopes);
	return [...scopes];
}
