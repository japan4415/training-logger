import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../../src/api/routes.js";
import { PHOTO_MAX_BYTES } from "../../src/db/session-photos.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import type { Bindings } from "../../src/env.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const app = new Hono<{ Bindings: Bindings }>();
registerApiRoutes(app);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const allowEnv = () => ({
	...env,
	PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
});

function photoForm(bytes: Uint8Array, type = "image/jpeg") {
	const form = new FormData();
	form.set("photo", new File([bytes], "photo.jpg", { type }));
	return form;
}

describe("session photos API", () => {
	beforeAll(() => applyMigrations(env.DB));
	beforeEach(async () => {
		await cleanDatabase(env.DB);
		const listed = await env.PHOTOS.list({ prefix: "sessions/" });
		if (listed.objects.length) {
			await env.PHOTOS.delete(listed.objects.map((object) => object.key));
		}
	});

	it("posts, lists, and streams a photo with safe headers", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const created = await app.request(
			`/api/sessions/${session.id}/photos`,
			{ method: "POST", body: photoForm(JPEG) },
			allowEnv(),
		);
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as {
			photo: { id: string; url: string };
		};

		const listed = await app.request(
			`/api/sessions/${session.id}/photos`,
			{},
			allowEnv(),
		);
		expect(listed.status).toBe(200);
		expect((await listed.json()).photos).toHaveLength(1);

		const image = await app.request(createdBody.photo.url, {}, allowEnv());
		expect(image.status).toBe(200);
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(JPEG);
		expect(image.headers.get("Content-Type")).toBe("image/jpeg");
		expect(image.headers.get("Content-Length")).toBe(String(JPEG.byteLength));
		expect(image.headers.get("ETag")).toBeTruthy();
		expect(image.headers.get("Cache-Control")).toBe("private, no-store");
		expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(image.headers.get("Content-Disposition")).toBe("inline");
	});

	it("returns 400 for malformed multipart and unsupported or oversized data", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const path = `/api/sessions/${session.id}/photos`;
		const malformed = await app.request(
			path,
			{ method: "POST", body: new FormData() },
			allowEnv(),
		);
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).error).toBe("invalid_request");

		const unsupported = await app.request(
			path,
			{ method: "POST", body: photoForm(new TextEncoder().encode("GIF")) },
			allowEnv(),
		);
		expect(unsupported.status).toBe(400);
		expect((await unsupported.json()).error).toBe("unsupported_type");

		const large = new Uint8Array(PHOTO_MAX_BYTES + 1);
		large.set(JPEG);
		const tooLarge = await app.request(
			path,
			{ method: "POST", body: photoForm(large) },
			allowEnv(),
		);
		expect(tooLarge.status).toBe(400);
		expect((await tooLarge.json()).error).toBe("too_large");
	});

	it("returns 404 for a missing session", async () => {
		const response = await app.request(
			"/api/sessions/99999/photos",
			{ method: "POST", body: photoForm(JPEG) },
			allowEnv(),
		);
		expect(response.status).toBe(404);
	});

	it("returns 409 and leaves only four objects at the limit", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const path = `/api/sessions/${session.id}/photos`;
		for (let index = 0; index < 4; index++) {
			expect(
				(
					await app.request(
						path,
						{ method: "POST", body: photoForm(JPEG) },
						allowEnv(),
					)
				).status,
			).toBe(201);
		}
		const response = await app.request(
			path,
			{ method: "POST", body: photoForm(JPEG) },
			allowEnv(),
		);
		expect(response.status).toBe(409);
		expect((await response.json()).error).toBe("limit_exceeded");
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(4);
	});

	it("fails closed without Access settings and blocks cross-site requests", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const path = `/api/sessions/${session.id}/photos`;
		const unauthorized = await app.request(
			path,
			{ method: "POST", body: photoForm(JPEG) },
			{ ...env, PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: undefined },
		);
		expect(unauthorized.status).toBe(401);
		expect((await unauthorized.json()).error).toBe("access_not_configured");

		const forbidden = await app.request(
			path,
			{
				method: "POST",
				headers: { "Sec-Fetch-Site": "cross-site" },
				body: photoForm(JPEG),
			},
			allowEnv(),
		);
		expect(forbidden.status).toBe(403);
	});

	it("deletes a photo", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const created = await app.request(
			`/api/sessions/${session.id}/photos`,
			{ method: "POST", body: photoForm(JPEG) },
			allowEnv(),
		);
		const { photo } = (await created.json()) as { photo: { url: string } };
		const deleted = await app.request(
			photo.url,
			{ method: "DELETE" },
			allowEnv(),
		);
		expect(deleted.status).toBe(204);
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(0);
	});
});
