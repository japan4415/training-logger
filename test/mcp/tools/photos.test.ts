import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	listSessionPhotos,
	PHOTO_MAX_BASE64_CHARS,
	PHOTO_MAX_BYTES,
} from "../../../src/db/session-photos.js";
import { getOrCreateSession } from "../../../src/db/sessions.js";
import {
	createPhotoUploadLinkHandler,
	uploadSessionPhotoHandler,
} from "../../../src/mcp/tools/photos.js";
import { applyMigrations, cleanDatabase } from "../../db/test-helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("MCP photo tools", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(async () => {
		await cleanDatabase(env.DB);
		const listed = await env.PHOTOS.list({ prefix: "sessions/" });
		if (listed.objects.length) {
			await env.PHOTOS.delete(listed.objects.map((object) => object.key));
		}
	});

	it("creates a browser upload link for an existing session", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const result = await createPhotoUploadLinkHandler(env, {
			date: "2026-09-14",
		});
		expect(result).toMatchObject({
			session_id: session.id,
			max_photos: 4,
			max_bytes: 10 * 1024 * 1024,
		});
		expect("url" in result && result.url).toContain(`#photos`);
	});

	it("returns an MCP error when the session does not exist", async () => {
		const result = await createPhotoUploadLinkHandler(env, {
			date: "2026-09-14",
		});
		expect(result).toMatchObject({ isError: true });
	});

	it("stores a minimal PNG decoded from base64", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const result = await uploadSessionPhotoHandler(env, {
			date: "2026-09-14",
			data_base64: base64(PNG),
			content_type: "image/png",
		});

		expect(result).toMatchObject({
			session_id: session.id,
			date: "2026-09-14",
			content_type: "image/png",
			size_bytes: PNG.byteLength,
		});
		expect("photo_id" in result && result.photo_id).toEqual(expect.any(String));
		expect("url" in result && result.url).toBe(
			`/api/sessions/${session.id}/photos/${"photo_id" in result ? result.photo_id : ""}`,
		);
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(1);
	});

	it.each([
		["invalid characters", "%%%"],
		["URL-safe characters", "_w=="],
		["a newline", `${base64(PNG)}\n`],
		["misplaced padding", "AA=A"],
		["too many characters", "A".repeat(PHOTO_MAX_BASE64_CHARS + 1)],
	])("rejects invalid base64 containing %s", async (_case, dataBase64) => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				data_base64: dataBase64,
			}),
		).toMatchObject({ isError: true, error: "invalid_base64" });
	});

	it("rejects a declared content type that differs from magic bytes", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				data_base64: base64(PNG),
				content_type: "image/jpeg",
			}),
		).toMatchObject({ isError: true, error: "unsupported_type" });
		expect(await listSessionPhotos(env.DB, session.id)).toHaveLength(0);
	});

	it("rejects bytes without a supported image signature", async () => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				data_base64: base64(new TextEncoder().encode("text")),
			}),
		).toMatchObject({ isError: true, error: "unsupported_type" });
	});

	it("returns too_large when decoded bytes exceed 10 MiB", async () => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		const oversized = new Uint8Array(PHOTO_MAX_BYTES + 1);
		oversized.set(PNG);
		const binaryChunks: string[] = [];
		for (let offset = 0; offset < oversized.length; offset += 0x8000) {
			binaryChunks.push(
				String.fromCharCode(...oversized.subarray(offset, offset + 0x8000)),
			);
		}
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				data_base64: btoa(binaryChunks.join("")),
			}),
		).toMatchObject({ isError: true, error: "too_large" });
	});

	it("returns limit_exceeded on the fifth upload", async () => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		for (let index = 0; index < 4; index++) {
			expect(
				await uploadSessionPhotoHandler(env, {
					date: "2026-09-14",
					data_base64: base64(JPEG),
				}),
			).not.toMatchObject({ isError: true });
		}
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				data_base64: base64(JPEG),
			}),
		).toMatchObject({ isError: true, error: "limit_exceeded" });
	});

	it("returns an MCP error when uploading without a session", async () => {
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				data_base64: base64(PNG),
			}),
		).toMatchObject({
			isError: true,
			error: expect.stringContaining("先に log_workout で登録してください"),
		});
	});
});
