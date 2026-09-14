import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	detectPhotoContentType,
	PHOTO_ALLOWED_TYPES,
	PHOTO_MAX_BASE64_CHARS,
	PHOTO_MAX_BYTES,
	PHOTO_MAX_PER_SESSION,
	storeSessionPhoto,
} from "../../db/session-photos.js";
import { getSessionByDate } from "../../db/sessions.js";
import type { Bindings } from "../../env.js";

const SITE_ORIGIN = "https://training-logger.discord.jp";

const PHOTO_ERROR_MESSAGES = {
	session_not_found:
		"指定日のワークアウトがありません。先に log_workout で登録してください。",
	invalid_base64:
		"data_base64 は改行なしの標準 base64（英数字、+、/、末尾の = のみ）で指定してください。",
	unsupported_type:
		"JPEG / PNG / WebP の画像を指定してください。content_type を指定した場合は画像本体の形式と一致させてください。",
	too_large: "写真は 1 枚 10 MiB 以下にしてください。",
	limit_exceeded: "1 セッションに保存できる写真は 4 枚までです。",
} as const;

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
	if (
		value.length === 0 ||
		value.length > PHOTO_MAX_BASE64_CHARS ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	) {
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
		const canonical = btoa(decoded);
		if (
			(firstPadding === -1 ? canonical.replace(/=+$/, "") : canonical) !== value
		) {
			throw new Error("Invalid base64 data");
		}
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		throw new Error("Invalid base64 data");
	}
}

export async function uploadSessionPhotoHandler(
	env: Bindings,
	params: {
		date: string;
		data_base64: string;
		content_type?: (typeof PHOTO_ALLOWED_TYPES)[number];
	},
) {
	const session = await getSessionByDate(env.DB, params.date);
	if (!session) {
		return {
			isError: true as const,
			error: "session_not_found",
			message: PHOTO_ERROR_MESSAGES.session_not_found,
		};
	}

	let bytes: Uint8Array;
	try {
		bytes = decodeBase64Strict(params.data_base64);
	} catch {
		return {
			isError: true as const,
			error: "invalid_base64",
			message: PHOTO_ERROR_MESSAGES.invalid_base64,
		};
	}

	if (bytes.byteLength > PHOTO_MAX_BYTES) {
		return {
			isError: true as const,
			error: "too_large",
			message: PHOTO_ERROR_MESSAGES.too_large,
		};
	}

	const detectedContentType = detectPhotoContentType(bytes);
	if (
		!detectedContentType ||
		(params.content_type !== undefined &&
			params.content_type !== detectedContentType)
	) {
		return {
			isError: true as const,
			error: "unsupported_type",
			message: PHOTO_ERROR_MESSAGES.unsupported_type,
		};
	}

	const result = await storeSessionPhoto(env, session, bytes);
	if (!result.ok) {
		return {
			isError: true as const,
			error: result.error,
			message: PHOTO_ERROR_MESSAGES[result.error],
		};
	}
	return {
		photo_id: result.photo.id,
		session_id: session.id,
		date: params.date,
		content_type: result.photo.content_type,
		size_bytes: result.photo.size_bytes,
		url: `/api/sessions/${session.id}/photos/${result.photo.id}`,
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
				"ワークアウト記録に使った写真を保存するためのアップロード画面のリンクを返します。チャットの添付画像など、ローカルファイルとして読めない画像を保存する場合にユーザーへ案内してください。",
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
				"ワークアウト記録に使った写真（JPEG / PNG / WebP、10 MiB 以下）を base64 で直接保存します。Claude Code などローカルファイルを読める環境向けです。チャットの添付画像は送れないため、その場合は create_photo_upload_link を使ってください。",
			inputSchema: {
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("セッション日付 (YYYY-MM-DD)"),
				data_base64: z
					.string()
					.min(1)
					.describe("画像本体の標準 base64（改行なし）"),
				content_type: z
					.enum(PHOTO_ALLOWED_TYPES)
					.optional()
					.describe(
						"画像の MIME type（任意。画像本体と一致する必要があります）",
					),
			},
		},
		async (args) => toolResponse(await uploadSessionPhotoHandler(env, args)),
	);
}
