import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bindings } from "../env.js";
import { registerExerciseTools } from "./tools/exercises.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerWorkoutTools } from "./tools/workouts.js";

/**
 * Server-level instructions exposed via MCP InitializeResult.instructions.
 *
 * Clients (ChatGPT, Claude, etc.) MAY inject this text into the LLM system
 * prompt. It complements per-tool descriptions with cross-cutting operational
 * rules that apply regardless of which tool is called.
 */
const SERVER_INSTRUCTIONS = `\
個人用の筋トレ記録サーバーです。以下のルールに従ってください。

■ 種目の登録
- 新しい種目を登録する前に、必ず search_exercises で既存種目を検索して重複がないか確認してください。
- 日本語名と英語名の両方で検索すると確実です。

■ 日時の扱い
- 日付はすべて Asia/Tokyo (JST) 基準です。date パラメータを省略すると JST の今日が使われます。
- ユーザーが「昨日」「先週月曜」のような相対表現を使った場合、JST で解釈してください。

■ 記録の運用
- 同じ日に再度 log_workout を呼ぶと、既存セッションに種目が追加されます（上書きではありません）。
- 記録の修正には update_workout、削除には delete_workout を使ってください。

■ 対応できない入力
- ツールのスキーマで表現できない種目パラメータや測定単位に遭遇した場合、その旨をユーザーに伝えてください。
- 必要に応じて https://github.com/japan4415/training-logger/issues/new への issue 起票を案内してください。`;

/**
 * Create a new McpServer instance configured for training-logger.
 *
 * Called once per request (stateless design).
 *
 * @param env - Worker bindings (DB etc.) passed to each tool registrar.
 */
export function createMcpServer(env: Bindings): McpServer {
	const server = new McpServer(
		{
			name: "training-logger",
			version: "0.1.0",
		},
		{
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	registerExerciseTools(server, env);
	registerWorkoutTools(server, env);
	registerHistoryTools(server, env);

	return server;
}
