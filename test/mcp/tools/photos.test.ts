import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateSession } from "../../../src/db/sessions.js";
import { createPhotoUploadLinkHandler } from "../../../src/mcp/tools/photos.js";
import { applyMigrations, cleanDatabase } from "../../db/test-helpers.js";

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
});
