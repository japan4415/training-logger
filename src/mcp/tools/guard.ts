/**
 * Issue #66 Phase 4b: ツール層の認可ガード。
 *
 * `apiHandler` が transport 側で scope 不足を 403 `insufficient_scope` として返す
 * のに加え、ツール層でも同じ判定を行う（二重防御）。`owner` 限定ツールはここで
 * `role` を検査し、他ユーザーが共有マスタや issue 起票へ到達しないようにする。
 * いずれも MCP のツールエラー（`isError: true`）として返し、HTTP ステータスは
 * 変えない。
 */

import type { McpContext } from "../context.js";
import { requiredToolScope } from "../scopes.js";

/**
 * MCP のツールエラー応答。SDK の `CallToolResult` は index signature を持つため、
 * こちらにも持たせて `registerTool` のコールバック戻り値として代入可能にする。
 */
export interface ToolErrorResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError: true;
}

/** MCP のツールエラー応答を組み立てる。 */
export function toolError(message: string): ToolErrorResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: message }) }],
		isError: true,
	};
}

/**
 * ツールの必要 scope を検査する。不足していればツールエラーを返す。
 * scope を要求しないツール（表に無いもの）は null を返す。
 */
export function requireScope(
	ctx: McpContext,
	toolName: string,
): ToolErrorResult | null {
	const required = requiredToolScope(toolName);
	if (required && !ctx.scopes.includes(required)) {
		return toolError(
			`この操作には ${required} スコープが必要です。クライアントを再認可してください。`,
		);
	}
	return null;
}

/** `owner` 限定操作。メンバーにはツールエラーを返す。 */
export function requireOwner(ctx: McpContext): ToolErrorResult | null {
	if (ctx.role !== "owner") {
		return toolError("この操作はオーナーのみ実行できます。");
	}
	return null;
}
