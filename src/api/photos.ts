import type { Context } from "hono";
import {
	deleteSessionPhoto,
	getSessionPhoto,
	listSessionPhotos,
	storeSessionPhoto,
} from "../db/session-photos.js";
import { getSessionById } from "../db/sessions.js";
import type { SessionPhotoRow } from "../db/types.js";
import type { Bindings } from "../env.js";
import { requireAccessUser } from "../security/access-auth.js";

type AppContext = Context<{ Bindings: Bindings }>;

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
	const id = sessionId(c);
	if (!id) return c.json({ error: "Invalid session ID" }, 400);
	if (!(await getSessionById(c.env.DB, id))) {
		return c.json({ error: "Session not found" }, 404);
	}
	const photos = await listSessionPhotos(c.env.DB, id);
	return c.json({ photos: photos.map(photoJson) });
}

export async function getPhoto(c: AppContext) {
	const id = sessionId(c);
	if (!id) return c.json({ error: "Invalid session ID" }, 400);
	const photo = await getSessionPhoto(
		c.env.DB,
		id,
		c.req.param("photoId") ?? "",
	);
	if (!photo) return c.json({ error: "Photo not found" }, 404);
	const object = await c.env.PHOTOS.get(photo.r2_key);
	if (!object) return c.json({ error: "Photo not found" }, 404);
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
	const auth = await requireAccessUser(c);
	if (!auth.ok) return auth.response;
	const id = sessionId(c);
	if (!id) return c.json({ error: "invalid_request" }, 400);
	const session = await getSessionById(c.env.DB, id);
	if (!session) return c.json({ error: "Session not found" }, 404);

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
	const result = await storeSessionPhoto(
		c.env,
		session,
		new Uint8Array(await file.arrayBuffer()),
	);
	if (!result.ok) {
		const status = result.error === "limit_exceeded" ? 409 : 400;
		return c.json({ error: result.error }, status);
	}
	return c.json({ photo: photoJson(result.photo) }, 201);
}

export async function removePhoto(c: AppContext) {
	const auth = await requireAccessUser(c);
	if (!auth.ok) return auth.response;
	const id = sessionId(c);
	if (!id) return c.json({ error: "Invalid session ID" }, 400);
	const deleted = await deleteSessionPhoto(
		c.env,
		id,
		c.req.param("photoId") ?? "",
	);
	if (!deleted) return c.json({ error: "Photo not found" }, 404);
	return c.body(null, 204);
}
