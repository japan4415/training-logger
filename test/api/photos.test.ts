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
const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };
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
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
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
			{ method: "POST", headers: SAME_ORIGIN, body: new FormData() },
			allowEnv(),
		);
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).error).toBe("invalid_request");

		const unsupported = await app.request(
			path,
			{
				method: "POST",
				headers: SAME_ORIGIN,
				body: photoForm(new TextEncoder().encode("GIF")),
			},
			allowEnv(),
		);
		expect(unsupported.status).toBe(400);
		expect((await unsupported.json()).error).toBe("unsupported_type");

		const large = new Uint8Array(PHOTO_MAX_BYTES + 1);
		large.set(JPEG);
		const tooLarge = await app.request(
			path,
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(large) },
			allowEnv(),
		);
		expect(tooLarge.status).toBe(400);
		expect((await tooLarge.json()).error).toBe("too_large");

		const rejectedBeforeParsing = await app.request(
			path,
			{
				method: "POST",
				headers: {
					...SAME_ORIGIN,
					"Content-Length": String(PHOTO_MAX_BYTES + 64 * 1024 + 1),
				},
				body: photoForm(JPEG),
			},
			allowEnv(),
		);
		expect(rejectedBeforeParsing.status).toBe(413);
		expect((await rejectedBeforeParsing.json()).error).toBe("too_large");
	});

	it("redirects a native HTML form upload back to the photo section", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const response = await app.request(
			`/api/sessions/${session.id}/photos`,
			{
				method: "POST",
				headers: {
					...SAME_ORIGIN,
					Accept: "text/html,application/xhtml+xml",
					"Sec-Fetch-Mode": "navigate",
				},
				body: photoForm(JPEG),
			},
			allowEnv(),
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(
			`/sessions/${session.id}#photos`,
		);
	});

	it("returns 404 for a missing session", async () => {
		const response = await app.request(
			"/api/sessions/99999/photos",
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
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
						{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
						allowEnv(),
					)
				).status,
			).toBe(201);
		}
		const response = await app.request(
			path,
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
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
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
			{ ...env, PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: undefined },
		);
		expect(unauthorized.status).toBe(401);
		expect((await unauthorized.json()).error).toBe("access_not_configured");

		const readUnauthorized = await app.request(
			path,
			{},
			{ ...env, PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: undefined },
		);
		expect(readUnauthorized.status).toBe(401);
		expect((await readUnauthorized.json()).error).toBe("access_not_configured");

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
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
			allowEnv(),
		);
		const { photo } = (await created.json()) as { photo: { url: string } };
		const deleted = await app.request(
			photo.url,
			{ method: "DELETE", headers: SAME_ORIGIN },
			allowEnv(),
		);
		expect(deleted.status).toBe(204);
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(0);
	});

	it("prunes a stale D1 row when the R2 object is missing from a list", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const created = await app.request(
			`/api/sessions/${session.id}/photos`,
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
			allowEnv(),
		);
		const { photo } = (await created.json()) as {
			photo: { id: string; url: string };
		};
		await env.PHOTOS.delete(`sessions/2026-09-14/${photo.id}.jpg`);

		const response = await app.request(
			`/api/sessions/${session.id}/photos`,
			{},
			allowEnv(),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).photos).toHaveLength(0);
		expect(
			await env.DB.prepare("SELECT id FROM session_photos WHERE id = ?")
				.bind(photo.id)
				.first(),
		).toBeNull();
	});

	it("returns 404 and prunes metadata when an image body is missing", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const created = await app.request(
			`/api/sessions/${session.id}/photos`,
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
			allowEnv(),
		);
		const { photo } = (await created.json()) as {
			photo: { id: string; url: string };
		};
		await env.PHOTOS.delete(`sessions/2026-09-14/${photo.id}.jpg`);

		const response = await app.request(photo.url, {}, allowEnv());
		expect(response.status).toBe(404);
		expect(
			await env.DB.prepare("SELECT id FROM session_photos WHERE id = ?")
				.bind(photo.id)
				.first(),
		).toBeNull();
	});

	it("rejects a delete when Sec-Fetch-Site is missing", async () => {
		const { session } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const created = await app.request(
			`/api/sessions/${session.id}/photos`,
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
			allowEnv(),
		);
		const { photo } = (await created.json()) as { photo: { url: string } };

		const response = await app.request(
			photo.url,
			{ method: "DELETE" },
			allowEnv(),
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("csrf_forbidden");
		expect(
			(await env.PHOTOS.list({ prefix: "sessions/" })).objects,
		).toHaveLength(1);
	});

	it("returns 404 when a photo is addressed through another session", async () => {
		const { session: owner } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-14",
		});
		const { session: other } = await getOrCreateSession(env.DB, {
			sessionDate: "2026-09-15",
		});
		const created = await app.request(
			`/api/sessions/${owner.id}/photos`,
			{ method: "POST", headers: SAME_ORIGIN, body: photoForm(JPEG) },
			allowEnv(),
		);
		const { photo } = (await created.json()) as {
			photo: { id: string; url: string };
		};

		const wrongPath = `/api/sessions/${other.id}/photos/${photo.id}`;
		expect((await app.request(wrongPath, {}, allowEnv())).status).toBe(404);
		expect(
			(
				await app.request(
					wrongPath,
					{ method: "DELETE", headers: SAME_ORIGIN },
					allowEnv(),
				)
			).status,
		).toBe(404);
		expect(
			await env.PHOTOS.get(`sessions/2026-09-14/${photo.id}.jpg`),
		).not.toBeNull();
	});
});
