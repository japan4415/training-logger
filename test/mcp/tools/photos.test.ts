import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateSession } from "../../../src/db/sessions.js";
import {
	createPhotoUploadLinkHandler,
	uploadSessionPhotoHandler,
} from "../../../src/mcp/tools/photos.js";
import { applyMigrations, cleanDatabase } from "../../db/test-helpers.js";

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

	it("uploads an image from base64", async () => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		const result = await uploadSessionPhotoHandler(env, {
			date: "2026-09-14",
			content_type: "image/jpeg",
			data_base64: base64(JPEG),
		});
		expect(result).toMatchObject({
			content_type: "image/jpeg",
			size_bytes: JPEG.byteLength,
		});
	});

	it("rejects invalid base64 and unsupported bytes", async () => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				content_type: "image/jpeg",
				data_base64: "%%%",
			}),
		).toMatchObject({ isError: true });
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				content_type: "image/jpeg",
				data_base64: base64(new TextEncoder().encode("text")),
			}),
		).toMatchObject({ isError: true, error: "unsupported_type" });
	});

	it("returns limit_exceeded on the fifth upload", async () => {
		await getOrCreateSession(env.DB, { sessionDate: "2026-09-14" });
		for (let index = 0; index < 4; index++) {
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				content_type: "image/jpeg",
				data_base64: base64(JPEG),
			});
		}
		expect(
			await uploadSessionPhotoHandler(env, {
				date: "2026-09-14",
				content_type: "image/jpeg",
				data_base64: base64(JPEG),
			}),
		).toMatchObject({ isError: true, error: "limit_exceeded" });
	});
});
