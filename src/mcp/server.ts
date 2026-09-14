import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bindings } from "../env.js";
import { registerExerciseTools } from "./tools/exercises.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerPhotoTools } from "./tools/photos.js";
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
新規登録前に search_exercises で日本語名・英語名の両方を検索して重複確認してください。

■ 日時の扱い
すべて Asia/Tokyo です。date 省略時は JST の今日が使われます。相対表現も JST で解釈してください。

■ 記録の運用
同日の log_workout 再呼び出しは追記です。修正は update_workout、削除は delete_workout を使ってください。ノート画像からの登録は、不明点を確認し下書きをユーザーに見せて承認を得てから log_workout を呼んでください（詳細な手順は Skill log-workout を参照）。ノート写真を保存したい場合は log_workout の後、ローカルファイルを読める場合は upload_session_photo、それ以外は create_photo_upload_link でリンクを案内してください。

■ 対応できない入力
ツールのスキーマで表現できない項目・単位に遭遇したらユーザーに伝え、同意を得て create_feedback で issue を起票してください。

■ 手書きノートの速記法
「reps/weight」形式（例「20/10」= 20回・重量10）です。複数並ぶ場合は各々を独立したセットとして扱ってください。単位不明なら get_history で前回を参照するかユーザーに確認してください。`;

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
	registerPhotoTools(server, env);
	registerFeedbackTools(server, env);

	return server;
}
