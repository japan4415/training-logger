import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	ACCESS_IDENTITY_PROVIDER,
	resolveAccessIdentity,
} from "../../src/db/users.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

async function seedUser(
	id: number,
	status: "active" | "disabled",
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO users (id, display_name, status, role) VALUES (?, NULL, ?, 'member')",
	)
		.bind(id, status)
		.run();
}

async function seedIdentity(params: {
	userId: number;
	subject?: string | null;
	email?: string | null;
}): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO user_identities (user_id, provider, subject, email)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(
			params.userId,
			ACCESS_IDENTITY_PROVIDER,
			params.subject ?? null,
			params.email ?? null,
		)
		.run();
}

describe("resolveAccessIdentity", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	it("resolves an already linked (provider, subject) to the internal user id", async () => {
		// The default owner (users.id = 1) already exists after cleanDatabase.
		await seedIdentity({ userId: 1, subject: "subject-owner" });

		await expect(
			resolveAccessIdentity(env.DB, { subject: "subject-owner" }),
		).resolves.toEqual({ status: "resolved", userId: 1 });
	});

	it("binds a subject to a NULL-subject invite row matched by email", async () => {
		await seedUser(2, "active");
		await seedIdentity({ userId: 2, email: "invitee@example.com" });

		await expect(
			resolveAccessIdentity(env.DB, {
				subject: "subject-invitee",
				email: "invitee@example.com",
			}),
		).resolves.toEqual({ status: "resolved", userId: 2 });

		const row = await env.DB.prepare(
			"SELECT subject FROM user_identities WHERE user_id = ?",
		)
			.bind(2)
			.first<{ subject: string | null }>();
		expect(row?.subject).toBe("subject-invitee");
	});

	it("matches the invite email case-insensitively", async () => {
		await seedUser(2, "active");
		await seedIdentity({ userId: 2, email: "Invitee@Example.com" });

		await expect(
			resolveAccessIdentity(env.DB, {
				subject: "subject-invitee",
				email: "invitee@example.com",
			}),
		).resolves.toEqual({ status: "resolved", userId: 2 });
	});

	it("does not overwrite or re-link a subject that is already bound", async () => {
		await seedUser(2, "active");
		await seedIdentity({ userId: 2, email: "invitee@example.com" });

		await resolveAccessIdentity(env.DB, {
			subject: "subject-first",
			email: "invitee@example.com",
		});

		// A different subject with the same email cannot take over the invite row.
		await expect(
			resolveAccessIdentity(env.DB, {
				subject: "subject-second",
				email: "invitee@example.com",
			}),
		).resolves.toEqual({ status: "not_registered" });

		const row = await env.DB.prepare(
			"SELECT subject FROM user_identities WHERE user_id = ?",
		)
			.bind(2)
			.first<{ subject: string | null }>();
		expect(row?.subject).toBe("subject-first");
	});

	it("treats an unknown subject as not registered without creating a user", async () => {
		await expect(
			resolveAccessIdentity(env.DB, {
				subject: "unknown",
				email: "someone@example.com",
			}),
		).resolves.toEqual({ status: "not_registered" });

		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM users",
		).first<{ n: number }>();
		expect(count?.n).toBe(1); // only the default owner
	});

	it("never auto-links an existing user by email without an invite row", async () => {
		await seedUser(2, "active");
		await seedIdentity({ userId: 2, subject: "subject-owner" });

		await expect(
			resolveAccessIdentity(env.DB, {
				subject: "new-device",
				email: "invitee@example.com",
			}),
		).resolves.toEqual({ status: "not_registered" });
	});

	it("rejects a linked user whose status is disabled", async () => {
		await seedUser(3, "disabled");
		await seedIdentity({ userId: 3, subject: "subject-disabled" });

		await expect(
			resolveAccessIdentity(env.DB, { subject: "subject-disabled" }),
		).resolves.toEqual({ status: "disabled" });
	});

	it("rejects a disabled invitee before binding the subject", async () => {
		await seedUser(3, "disabled");
		await seedIdentity({ userId: 3, email: "invitee@example.com" });

		await expect(
			resolveAccessIdentity(env.DB, {
				subject: "subject-invitee",
				email: "invitee@example.com",
			}),
		).resolves.toEqual({ status: "disabled" });

		const row = await env.DB.prepare(
			"SELECT subject FROM user_identities WHERE user_id = ?",
		)
			.bind(3)
			.first<{ subject: string | null }>();
		expect(row?.subject).toBeNull();
	});

	it("returns not_registered when neither subject nor email can be matched", async () => {
		await expect(
			resolveAccessIdentity(env.DB, { subject: "subject", email: null }),
		).resolves.toEqual({ status: "not_registered" });
	});
});
