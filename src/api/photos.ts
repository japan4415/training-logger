import type { Context } from "hono";
import {
	deleteSessionPhoto,
	getSessionPhoto,
	listExistingSessionPhotos,
	PHOTO_MAX_BYTES,
	removeMissingSessionPhotoMetadata,
	storeSessionPhoto,
} from "../db/session-photos.js";
import { getSessionById } from "../db/sessions.js";
import type { SessionPhotoRow } from "../db/types.js";
import type { AppEnv } from "../env.js";
import { requireUserId } from "../security/auth.js";

type AppContext = Context<AppEnv>;
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

function sessionId(c: AppContext): number | null {
	const id = Number(c.req.param("id"));
	return Number.isInteger(id) && id > 0 ? id : null;
}

function photoJson(photo: SessionPhotoRow) {
	return {
		id: photo.id,
		content_type: photo.content_type,
		size_bytes: photo.size_bytes,
		created_at: photo.created_at,
		url: `/api/sessions/${photo.session_id}/photos/${photo.id}`,
	};
}

export async function listPhotos(c: AppContext) {
	// 認証・CSRF は registerAccessAuth のミドルウェアで共通化している。
	const userId = requireUserId(c);
	const id = sessionId(c);
	if (!id) return c.json({ error: "Invalid session ID" }, 400);
	if (!(await getSessionById(c.env.DB, userId, id))) {
		return c.json({ error: "Session not found" }, 404);
	}
	const photos = await listExistingSessionPhotos(c.env, userId, id);
	return c.json({ photos: photos.map(photoJson) });
}

export async function getPhoto(c: AppContext) {
	const userId = requireUserId(c);
	const id = sessionId(c);
	if (!id) return c.json({ error: "Invalid session ID" }, 400);
	const photo = await getSessionPhoto(
		c.env.DB,
		userId,
		id,
		c.req.param("photoId") ?? "",
	);
	if (!photo) return c.json({ error: "Photo not found" }, 404);
	const object = await c.env.PHOTOS.get(photo.r2_key);
	if (!object) {
		await removeMissingSessionPhotoMetadata(c.env.DB, userId, photo);
		return c.json({ error: "Photo not found" }, 404);
	}
	return new Response(object.body, {
		headers: {
			"Content-Type": photo.content_type,
			"Content-Length": String(photo.size_bytes),
			ETag: object.httpEtag,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Disposition": "inline",
		},
	});
}

export async function createPhoto(c: AppContext) {
	const userId = requireUserId(c);
	const id = sessionId(c);
	if (!id) return c.json({ error: "invalid_request" }, 400);
	const session = await getSessionById(c.env.DB, userId, id);
	if (!session) return c.json({ error: "Session not found" }, 404);
	const contentLengthHeader = c.req.header("Content-Length");
	if (contentLengthHeader === undefined) {
		return c.json({ error: "length_required" }, 411);
	}
	const contentLength = Number(contentLengthHeader);
	if (
		Number.isFinite(contentLength) &&
		contentLength > PHOTO_MAX_BYTES + MULTIPART_OVERHEAD_ALLOWANCE
	) {
		return c.json({ error: "too_large" }, 413);
	}

	let body: FormData;
	try {
		body = await c.req.formData();
	} catch {
		return c.json({ error: "invalid_request" }, 400);
	}
	const file = body.get("photo");
	if (!(file instanceof File)) {
		return c.json({ error: "invalid_request" }, 400);
	}
	if (file.size > PHOTO_MAX_BYTES) {
		return c.json({ error: "too_large" }, 400);
	}
	const result = await storeSessionPhoto(
		c.env,
		userId,
		session,
		new Uint8Array(await file.arrayBuffer()),
	);
	if (!result.ok) {
		const status = result.error === "limit_exceeded" ? 409 : 400;
		return c.json({ error: result.error }, status);
	}
	const acceptsHtml = c.req
		.header("Accept")
		?.toLowerCase()
		.includes("text/html");
	const isNavigation =
		c.req.header("Sec-Fetch-Mode")?.toLowerCase() === "navigate";
	if (acceptsHtml && isNavigation) {
		return c.redirect(`/sessions/${id}#photos`, 303);
	}
	return c.json({ photo: photoJson(result.photo) }, 201);
}

export async function removePhoto(c: AppContext) {
	const userId = requireUserId(c);
	const id = sessionId(c);
	if (!id) return c.json({ error: "Invalid session ID" }, 400);
	const deleted = await deleteSessionPhoto(
		c.env,
		userId,
		id,
		c.req.param("photoId") ?? "",
	);
	if (!deleted) return c.json({ error: "Photo not found" }, 404);
	return c.body(null, 204);
}
