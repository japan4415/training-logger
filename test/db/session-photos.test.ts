import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteSessionPhoto,
	listExistingSessionPhotos,
	listSessionPhotos,
	PHOTO_MAX_BYTES,
	storeSessionPhoto,
} from "../../src/db/session-photos.js";
import { deleteSession, getOrCreateSession } from "../../src/db/sessions.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

const IMAGES = {
	jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
	png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	webp: new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
	]),
};

async function cleanPhotos() {
	const listed = await env.PHOTOS.list({ prefix: "sessions/" });
	if (listed.objects.length) {
		await env.PHOTOS.delete(listed.objects.map((object) => object.key));
	}
}

function bucketWithFailingDelete(message: string): R2Bucket {
	return new Proxy(env.PHOTOS, {
		get(target, property) {
			if (property === "delete") {
				return async () => {
					throw new Error(message);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("session photos DB service", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await cleanPhotos();
	});

	it.each([
		["image/jpeg", IMAGES.jpeg],
		["image/png", IMAGES.png],
		["image/webp", IMAGES.webp],
	] as const)("stores %s using magic bytes", async (contentType, bytes) => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const result = await storeSessionPhoto(env, session, bytes);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.photo.content_type).toBe(contentType);
		expect(result.photo.size_bytes).toBe(bytes.byteLength);
		expect(await env.PHOTOS.get(result.photo.r2_key)).not.toBeNull();
	});

	it.each([
		new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
		new TextEncoder().encode("<svg></svg>"),
		new TextEncoder().encode("plain text"),
	])("rejects unsupported content without writing R2", async (bytes) => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		expect(await storeSessionPhoto(env, session, bytes)).toEqual({
			ok: false,
			error: "unsupported_type",
		});
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(0);
	});

	it("rejects a file over 10 MiB", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const bytes = new Uint8Array(PHOTO_MAX_BYTES + 1);
		bytes.set(IMAGES.jpeg);
		expect(await storeSessionPhoto(env, session, bytes)).toEqual({
			ok: false,
			error: "too_large",
		});
	});

	it("enforces four photos atomically and compensates the fifth R2 put", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		for (let index = 0; index < 4; index++) {
			expect((await storeSessionPhoto(env, session, IMAGES.jpeg)).ok).toBe(
				true,
			);
		}
		expect(await storeSessionPhoto(env, session, IMAGES.jpeg)).toEqual({
			ok: false,
			error: "limit_exceeded",
		});
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(4);
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(4);
	});

	it("preserves the limit result when its R2 compensation fails", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		for (let index = 0; index < 4; index++) {
			expect((await storeSessionPhoto(env, session, IMAGES.jpeg)).ok).toBe(
				true,
			);
		}
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await storeSessionPhoto(
			{ ...env, PHOTOS: bucketWithFailingDelete("compensation failed") },
			session,
			IMAGES.jpeg,
		);
		expect(result).toEqual({ ok: false, error: "limit_exceeded" });
		expect(error).toHaveBeenCalledWith(
			"Failed to compensate session photo R2 put",
			expect.objectContaining({ reason: "photo limit exceeded" }),
		);
		error.mockRestore();
	});

	it("compensates the R2 put when the D1 insert fails", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const failingDb = {
			prepare(query: string) {
				if (query.includes("INSERT INTO session_photos")) {
					return {
						bind() {
							return {
								run() {
									throw new Error("injected D1 insert failure");
								},
							};
						},
					};
				}
				return env.DB.prepare(query);
			},
		} as unknown as D1Database;

		await expect(
			storeSessionPhoto({ ...env, DB: failingDb }, session, IMAGES.jpeg),
		).rejects.toThrow("injected D1 insert failure");
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(0);
	});

	it("preserves a D1 insert error when R2 compensation also fails", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const failingDb = {
			prepare(query: string) {
				if (query.includes("INSERT INTO session_photos")) {
					return {
						bind() {
							return {
								run() {
									throw new Error("original D1 insert failure");
								},
							};
						},
					};
				}
				return env.DB.prepare(query);
			},
		} as unknown as D1Database;
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			storeSessionPhoto(
				{
					...env,
					DB: failingDb,
					PHOTOS: bucketWithFailingDelete("compensation failed"),
				},
				session,
				IMAGES.jpeg,
			),
		).rejects.toThrow("original D1 insert failure");
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("deletes one photo from D1 and R2", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.png);
		if (!stored.ok) throw new Error(stored.error);
		expect(await deleteSessionPhoto(env, session.id, stored.photo.id)).toBe(
			true,
		);
		expect(await env.PHOTOS.get(stored.photo.r2_key)).toBeNull();
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(0);
	});

	it("keeps photo metadata when a single-photo R2 deletion fails", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.png);
		if (!stored.ok) throw new Error(stored.error);

		await expect(
			deleteSessionPhoto(
				{ ...env, PHOTOS: bucketWithFailingDelete("R2 delete failed") },
				session.id,
				stored.photo.id,
			),
		).rejects.toThrow("R2 delete failed");
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(1);
		expect(await env.PHOTOS.get(stored.photo.r2_key)).not.toBeNull();
	});

	it("prunes metadata after R2 deletion followed by a D1 delete failure", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.png);
		if (!stored.ok) throw new Error(stored.error);
		const failingDb = {
			prepare(query: string) {
				if (query.startsWith("DELETE FROM session_photos")) {
					return {
						bind() {
							return {
								run() {
									throw new Error("injected D1 delete failure");
								},
							};
						},
					};
				}
				return env.DB.prepare(query);
			},
		} as unknown as D1Database;

		await expect(
			deleteSessionPhoto(
				{ ...env, DB: failingDb },
				session.id,
				stored.photo.id,
			),
		).rejects.toThrow("injected D1 delete failure");
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(1);
		expect(await env.PHOTOS.get(stored.photo.r2_key)).toBeNull();
		expect(await listExistingSessionPhotos(env, session.id)).toHaveLength(0);
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(0);
	});

	it("deleteSession removes linked R2 objects", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.webp);
		if (!stored.ok) throw new Error(stored.error);
		expect(await deleteSession(env, session.id)).toBe(true);
		expect(await env.PHOTOS.get(stored.photo.r2_key)).toBeNull();
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(0);
	});

	it("post-sweeps an object created during session deletion", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.webp);
		if (!stored.ok) throw new Error(stored.error);
		let injected = false;
		const photos = new Proxy(env.PHOTOS, {
			get(target, property) {
				if (property === "delete") {
					return async (keys: string | string[]) => {
						await target.delete(keys);
						if (!injected) {
							injected = true;
							await target.put(
								"sessions/2026-09-14/concurrent-upload.jpg",
								IMAGES.jpeg,
							);
						}
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		expect(await deleteSession({ ...env, PHOTOS: photos }, session.id)).toBe(
			true,
		);
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/2026-09-14/" })).objects,
		).toHaveLength(0);
	});

	it("keeps a successful D1 deletion when the post-sweep fails", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const photos = new Proxy(env.PHOTOS, {
			get(target, property) {
				if (property === "list") {
					return async () => {
						throw new Error("injected R2 list failure");
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await deleteSession({ ...env, PHOTOS: photos }, session.id)).toBe(
			true,
		);
		expect(error).toHaveBeenCalledWith(
			"Failed to sweep session photo R2 objects",
			expect.objectContaining({ prefix: "sessions/2026-09-14/" }),
		);
		expect(
			await env.DB.prepare("SELECT id FROM workout_sessions WHERE id = ?")
				.bind(session.id)
				.first(),
		).toBeNull();
		error.mockRestore();
	});

	it("keeps the session and photo row when R2 deletion fails", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.jpeg);
		if (!stored.ok) throw new Error(stored.error);
		const failingPhotos = {
			delete() {
				throw new Error("injected R2 delete failure");
			},
		} as unknown as R2Bucket;

		await expect(
			deleteSession({ ...env, PHOTOS: failingPhotos }, session.id),
		).rejects.toThrow("injected R2 delete failure");
		expect(
			await env.DB.prepare("SELECT id FROM workout_sessions WHERE id = ?")
				.bind(session.id)
				.first(),
		).not.toBeNull();
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(1);
		expect(await env.PHOTOS.get(stored.photo.r2_key)).not.toBeNull();
	});
});
