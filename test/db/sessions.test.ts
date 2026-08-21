import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	deleteSession,
	getOrCreateSession,
	getRecentSessions,
	getSessionByDate,
	getSessionById,
	getSessionsByMonth,
} from "../../src/db/sessions.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

describe("sessions", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
	});

	describe("getOrCreateSession", () => {
		it("should create a new session", async () => {
			const { session, created } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
				goal: "ダイエット",
				bodyCondition: "左足首・膝の怪我歴あり",
				notes: "テストメモ",
			});
			expect(created).toBe(true);
			expect(session.session_date).toBe("2026-08-15");
			expect(session.goal).toBe("ダイエット");
			expect(session.body_condition).toBe("左足首・膝の怪我歴あり");
			expect(session.notes).toBe("テストメモ");
			expect(session.id).toBeGreaterThan(0);
		});

		it("should return existing session for same date (upsert)", async () => {
			const { session: first } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
				goal: "ダイエット",
			});
			const { session: second, created } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
				goal: "筋力アップ",
			});
			expect(created).toBe(false);
			expect(second.id).toBe(first.id);
			// Original goal is preserved, not overwritten
			expect(second.goal).toBe("ダイエット");
		});

		it("should create sessions for different dates", async () => {
			const { session: s1, created: c1 } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
			});
			const { session: s2, created: c2 } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-16",
			});
			expect(c1).toBe(true);
			expect(c2).toBe(true);
			expect(s1.id).not.toBe(s2.id);
		});

		it("should handle null optional fields", async () => {
			const { session } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
			});
			expect(session.goal).toBeNull();
			expect(session.body_condition).toBeNull();
			expect(session.notes).toBeNull();
		});
	});

	describe("getSessionById", () => {
		it("should return session by ID", async () => {
			const { session: created } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
			});
			const session = await getSessionById(env.DB, created.id);
			expect(session).not.toBeNull();
			expect(session?.session_date).toBe("2026-08-15");
		});

		it("should return null for non-existent ID", async () => {
			const session = await getSessionById(env.DB, 9999);
			expect(session).toBeNull();
		});
	});

	describe("getSessionByDate", () => {
		it("should return session by date", async () => {
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-15" });
			const session = await getSessionByDate(env.DB, "2026-08-15");
			expect(session).not.toBeNull();
			expect(session?.session_date).toBe("2026-08-15");
		});

		it("should return null for non-existent date", async () => {
			const session = await getSessionByDate(env.DB, "2099-01-01");
			expect(session).toBeNull();
		});
	});

	describe("getSessionsByMonth", () => {
		it("should return sessions for a specific month", async () => {
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-15" });
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-16" });
			await getOrCreateSession(env.DB, { sessionDate: "2026-09-01" });

			const sessions = await getSessionsByMonth(env.DB, 2026, 8);
			expect(sessions).toHaveLength(2);
			expect(sessions[0].session_date).toBe("2026-08-15");
			expect(sessions[1].session_date).toBe("2026-08-16");
		});

		it("should handle December correctly (year boundary)", async () => {
			await getOrCreateSession(env.DB, { sessionDate: "2026-12-01" });
			await getOrCreateSession(env.DB, { sessionDate: "2026-12-31" });
			await getOrCreateSession(env.DB, { sessionDate: "2027-01-01" });

			const sessions = await getSessionsByMonth(env.DB, 2026, 12);
			expect(sessions).toHaveLength(2);
		});

		it("should return empty array for month with no sessions", async () => {
			const sessions = await getSessionsByMonth(env.DB, 2026, 1);
			expect(sessions).toHaveLength(0);
		});
	});

	describe("getRecentSessions", () => {
		it("should return most recent sessions in descending date order", async () => {
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-14" });
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-15" });
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-16" });

			const sessions = await getRecentSessions(env.DB, 2);
			expect(sessions).toHaveLength(2);
			expect(sessions[0].session_date).toBe("2026-08-16");
			expect(sessions[1].session_date).toBe("2026-08-15");
		});

		it("should return all sessions when limit exceeds total", async () => {
			await getOrCreateSession(env.DB, { sessionDate: "2026-08-15" });
			const sessions = await getRecentSessions(env.DB, 10);
			expect(sessions).toHaveLength(1);
		});
	});

	describe("deleteSession", () => {
		it("should delete a session and return true", async () => {
			const { session } = await getOrCreateSession(env.DB, {
				sessionDate: "2026-08-15",
			});
			const deleted = await deleteSession(env.DB, session.id);
			expect(deleted).toBe(true);

			const found = await getSessionById(env.DB, session.id);
			expect(found).toBeNull();
		});

		it("should return false for non-existent session", async () => {
			const deleted = await deleteSession(env.DB, 9999);
			expect(deleted).toBe(false);
		});
	});
});
