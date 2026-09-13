import type { Bindings } from "../env.js";
import type { SessionPhotoRow } from "./types.js";

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_MAX_PER_SESSION = 4;
export const PHOTO_ALLOWED_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
] as const;

type PhotoContentType = (typeof PHOTO_ALLOWED_TYPES)[number];

const EXTENSIONS: Record<PhotoContentType, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((value, index) => bytes[index] === value);
}

/** Detect an allowed image type from its file signature, never from user input. */
export function detectPhotoContentType(
	bytes: Uint8Array,
): PhotoContentType | null {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

export async function listSessionPhotos(
	db: D1Database,
	sessionId: number,
): Promise<SessionPhotoRow[]> {
	const { results } = await db
		.prepare(
			"SELECT * FROM session_photos WHERE session_id = ? ORDER BY created_at, id",
		)
		.bind(sessionId)
		.all<SessionPhotoRow>();
	return results;
}

export async function getSessionPhoto(
	db: D1Database,
	sessionId: number,
	photoId: string,
): Promise<SessionPhotoRow | null> {
	return db
		.prepare("SELECT * FROM session_photos WHERE session_id = ? AND id = ?")
		.bind(sessionId, photoId)
		.first<SessionPhotoRow>();
}

async function deleteSessionPhotoMetadata(
	db: D1Database,
	sessionId: number,
	photoId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM session_photos WHERE session_id = ? AND id = ?")
		.bind(sessionId, photoId)
		.run();
}

/** Remove metadata for objects already missing from R2 and return usable photos. */
export async function listExistingSessionPhotos(
	env: Pick<Bindings, "DB" | "PHOTOS">,
	sessionId: number,
): Promise<SessionPhotoRow[]> {
	const photos = await listSessionPhotos(env.DB, sessionId);
	const objects = await Promise.all(
		photos.map(async (photo) => ({
			photo,
			object: await env.PHOTOS.head(photo.r2_key),
		})),
	);
	const existing: SessionPhotoRow[] = [];
	for (const { photo, object } of objects) {
		if (object) {
			existing.push(photo);
			continue;
		}
		await deleteSessionPhotoMetadata(env.DB, sessionId, photo.id);
		console.warn("Removed session photo metadata for a missing R2 object", {
			sessionId,
			photoId: photo.id,
			r2Key: photo.r2_key,
		});
	}
	return existing;
}

/** Remove one stale metadata row after an R2 miss. */
export async function removeMissingSessionPhotoMetadata(
	db: D1Database,
	photo: SessionPhotoRow,
): Promise<void> {
	await deleteSessionPhotoMetadata(db, photo.session_id, photo.id);
	console.warn("Removed session photo metadata for a missing R2 object", {
		sessionId: photo.session_id,
		photoId: photo.id,
		r2Key: photo.r2_key,
	});
}

async function compensateR2Put(
	bucket: R2Bucket,
	r2Key: string,
	reason: string,
): Promise<void> {
	try {
		await bucket.delete(r2Key);
	} catch (error) {
		console.error("Failed to compensate session photo R2 put", {
			r2Key,
			reason,
			error,
		});
	}
}

export async function storeSessionPhoto(
	env: Pick<Bindings, "DB" | "PHOTOS">,
	session: { id: number; session_date: string },
	bytes: Uint8Array,
): Promise<
	| { ok: true; photo: SessionPhotoRow }
	| {
			ok: false;
			error: "unsupported_type" | "too_large" | "limit_exceeded";
	  }
> {
	if (bytes.byteLength > PHOTO_MAX_BYTES) {
		return { ok: false, error: "too_large" };
	}
	const contentType = detectPhotoContentType(bytes);
	if (!contentType) return { ok: false, error: "unsupported_type" };

	const id = crypto.randomUUID();
	const r2Key = `sessions/${session.session_date}/${session.id}/${id}.${EXTENSIONS[contentType]}`;
	await env.PHOTOS.put(r2Key, bytes, {
		httpMetadata: {
			contentType,
			cacheControl: "private, no-store",
		},
	});

	try {
		const result = await env.DB.prepare(
			`INSERT INTO session_photos
				(id, session_id, r2_key, content_type, size_bytes)
			 SELECT ?, ?, ?, ?, ?
			 WHERE (SELECT COUNT(*) FROM session_photos WHERE session_id = ?) < ?`,
		)
			.bind(
				id,
				session.id,
				r2Key,
				contentType,
				bytes.byteLength,
				session.id,
				PHOTO_MAX_PER_SESSION,
			)
			.run();

		if (result.meta.changes === 0) {
			await compensateR2Put(env.PHOTOS, r2Key, "photo limit exceeded");
			return { ok: false, error: "limit_exceeded" };
		}
	} catch (error) {
		await compensateR2Put(env.PHOTOS, r2Key, "D1 insert failed");
		throw error;
	}

	const photo = await getSessionPhoto(env.DB, session.id, id);
	if (!photo) {
		await compensateR2Put(env.PHOTOS, r2Key, "stored row could not be read");
		throw new Error("Failed to retrieve stored session photo");
	}
	return { ok: true, photo };
}

export async function deleteSessionPhoto(
	env: Pick<Bindings, "DB" | "PHOTOS">,
	sessionId: number,
	photoId: string,
): Promise<boolean> {
	const photo = await getSessionPhoto(env.DB, sessionId, photoId);
	if (!photo) return false;
	await env.PHOTOS.delete(photo.r2_key);
	const result = await env.DB.prepare(
		"DELETE FROM session_photos WHERE session_id = ? AND id = ?",
	)
		.bind(sessionId, photoId)
		.run();
	return result.meta.changes > 0;
}

export async function deleteSessionPhotosForSession(
	env: Pick<Bindings, "DB" | "PHOTOS">,
	sessionId: number,
): Promise<void> {
	const photos = await listSessionPhotos(env.DB, sessionId);
	if (photos.length > 0) {
		await env.PHOTOS.delete(photos.map((photo) => photo.r2_key));
	}
}

/** Best-effort cleanup for objects created concurrently with session deletion. */
export async function sweepSessionPhotoObjects(
	bucket: R2Bucket,
	sessionDate: string,
	sessionId: number,
): Promise<void> {
	const prefix = `sessions/${sessionDate}/${sessionId}/`;
	try {
		let cursor: string | undefined;
		do {
			const listed = await bucket.list({ prefix, cursor });
			if (listed.objects.length > 0) {
				await bucket.delete(listed.objects.map((object) => object.key));
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	} catch (error) {
		console.error("Failed to sweep session photo R2 objects", {
			prefix,
			error,
		});
	}
}
