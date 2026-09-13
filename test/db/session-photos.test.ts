import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	deleteSessionPhoto,
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

	it("deleteSession removes linked R2 objects", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const stored = await storeSessionPhoto(env, session, IMAGES.webp);
		if (!stored.ok) throw new Error(stored.error);
		expect(await deleteSession(env, session.id)).toBe(true);
		expect(await env.PHOTOS.get(stored.photo.r2_key)).toBeNull();
	});
});
