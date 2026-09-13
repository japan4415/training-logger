import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	PHOTO_ALLOWED_TYPES,
	PHOTO_MAX_BYTES,
	PHOTO_MAX_PER_SESSION,
	storeSessionPhoto,
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

/** Decode RFC 4648 base64 without tolerating whitespace or misplaced padding. */
export function decodeBase64Strict(value: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new Error("Invalid base64 data");
	}
	const firstPadding = value.indexOf("=");
	if (firstPadding !== -1 && value.length % 4 !== 0) {
		throw new Error("Invalid base64 data");
	}
	const unpadded = firstPadding === -1 ? value : value.slice(0, firstPadding);
	if (unpadded.length % 4 === 1) throw new Error("Invalid base64 data");
	const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
	try {
		const decoded = atob(padded);
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		throw new Error("Invalid base64 data");
	}
}

export async function uploadSessionPhotoHandler(
	env: Bindings,
	params: {
		date: string;
		content_type: (typeof PHOTO_ALLOWED_TYPES)[number];
		data_base64: string;
	},
) {
	const session = await getSessionByDate(env.DB, params.date);
	if (!session) {
		return {
			isError: true as const,
			error: `${params.date} のワークアウトがありません。先に log_workout で登録してください。`,
		};
	}
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64Strict(params.data_base64);
	} catch {
		return { isError: true as const, error: "data_base64 が不正です。" };
	}
	const result = await storeSessionPhoto(env, session, bytes);
	if (!result.ok) return { isError: true as const, error: result.error };
	return {
		photo_id: result.photo.id,
		content_type: result.photo.content_type,
		size_bytes: result.photo.size_bytes,
		url: `${SITE_ORIGIN}/api/sessions/${session.id}/photos/${result.photo.id}`,
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

	server.registerTool(
		"upload_session_photo",
		{
			description:
				"Claude Code などローカルファイルを読める環境向けの補助です。10 MiB 以下の JPEG / PNG / WebP をワークアウト記録に保存します。",
			inputSchema: {
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("セッション日付 (YYYY-MM-DD)"),
				content_type: z.enum(PHOTO_ALLOWED_TYPES).describe("画像の MIME type"),
				data_base64: z.string().describe("画像本体の base64"),
			},
		},
		async (args) => toolResponse(await uploadSessionPhotoHandler(env, args)),
	);
}
