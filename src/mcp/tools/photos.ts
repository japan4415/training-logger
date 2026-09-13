import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	PHOTO_ALLOWED_TYPES,
	PHOTO_MAX_BYTES,
	PHOTO_MAX_PER_SESSION,
} from "../../db/session-photos.js";
import { getSessionByDate } from "../../db/sessions.js";
import type { Bindings } from "../../env.js";

const SITE_ORIGIN = "https://training-logger.discord.jp";

export interface PhotoToolError {
	isError: true;
	error: string;
}

export async function createPhotoUploadLinkHandler(
	env: Bindings,
	params: { date: string },
) {
	const session = await getSessionByDate(env.DB, params.date);
	if (!session) {
		return {
			isError: true as const,
			error: `${params.date} のワークアウトがありません。先に log_workout で登録してください。`,
		};
	}
	return {
		session_id: session.id,
		date: params.date,
		url: `${SITE_ORIGIN}/sessions/${session.id}#photos`,
		max_photos: PHOTO_MAX_PER_SESSION,
		max_bytes: PHOTO_MAX_BYTES,
		allowed_types: [...PHOTO_ALLOWED_TYPES],
		note: "ブラウザで開き、写真セクションから同じ写真を選んでアップロードしてください",
	};
}

function toolResponse(result: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		...(typeof result === "object" &&
		result !== null &&
		"isError" in result &&
		result.isError === true
			? { isError: true }
			: {}),
	};
}

export function registerPhotoTools(server: McpServer, env: Bindings): void {
	server.registerTool(
		"create_photo_upload_link",
		{
			description:
				"ワークアウト記録に使った写真を保存するためのアップロード画面のリンクを返します。写真は MCP 経由では送れないため、ユーザーにこのリンクを案内してください",
			inputSchema: {
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("セッション日付 (YYYY-MM-DD)"),
			},
		},
		async (args) => toolResponse(await createPhotoUploadLinkHandler(env, args)),
	);
}
