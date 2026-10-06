import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExercise } from "../../src/db/exercises.js";
import {
	getExerciseStats,
	getHistory,
	getSessionDetail,
} from "../../src/db/queries.js";
import {
	createSessionExercise,
	createSet,
	deleteSessionExercise,
	deleteSetsBySessionExercise,
	replaceSets,
	updateSessionExercise,
} from "../../src/db/records.js";
import {
	deleteSessionPhoto,
	getSessionPhoto,
	listSessionPhotos,
	storeSessionPhoto,
} from "../../src/db/session-photos.js";
import {
	assertSessionOwned,
	deleteSession,
	getOrCreateSession,
	getRecentSessions,
	getSessionByDate,
	getSessionById,
	getSessionsByMonth,
	updateSession,
} from "../../src/db/sessions.js";
import { applyMigrations, cleanDatabase } from "./test-helpers.js";

const USER_A = 1;
const USER_B = 2;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

async function createUserB(): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO users (id, display_name, status, role) VALUES (?, NULL, 'active', 'member')",
	)
		.bind(USER_B)
		.run();
}

async function cleanPhotos(): Promise<void> {
	const listed = await env.PHOTOS.list();
	if (listed.objects.length > 0) {
		await env.PHOTOS.delete(listed.objects.map((object) => object.key));
	}
}

describe("user data isolation (Phase 2)", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await cleanPhotos();
		await createUserB();
	});

	describe("composite UNIQUE (user_id, session_date)", () => {
		it("allows the same date for different users", async () => {
			const a = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const b = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
			});
			expect(a.created).toBe(true);
			expect(b.created).toBe(true);
			expect(a.session.id).not.toBe(b.session.id);
			expect(a.session.user_id).toBe(USER_A);
			expect(b.session.user_id).toBe(USER_B);
		});

		it("returns the existing session for the same user and date", async () => {
			const first = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const second = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			expect(second.created).toBe(false);
			expect(second.session.id).toBe(first.session.id);
		});

		it("rejects a duplicate (user_id, session_date) INSERT", async () => {
			await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			await expect(
				env.DB.prepare(
					"INSERT INTO workout_sessions (user_id, session_date) VALUES (?, ?)",
				)
					.bind(USER_A, "2026-08-15")
					.run(),
			).rejects.toThrow();
		});

		it("writes user_id explicitly instead of relying on DEFAULT 1", async () => {
			const { session } = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
			});
			// If the INSERT omitted user_id, the schema DEFAULT 1 would win.
			expect(session.user_id).toBe(USER_B);
		});
	});

	describe("sessions", () => {
		it("does not return another user's session by id", async () => {
			const { session: b } = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
			});
			expect(await getSessionById(env.DB, USER_A, b.id)).toBeNull();
			expect(await getSessionById(env.DB, USER_B, b.id)).not.toBeNull();
		});

		it("does not return another user's session by date", async () => {
			await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
			});
			expect(await getSessionByDate(env.DB, USER_A, "2026-08-15")).toBeNull();
			expect(
				await getSessionByDate(env.DB, USER_B, "2026-08-15"),
			).not.toBeNull();
		});

		it("scopes month and recent queries to the user", async () => {
			await getOrCreateSession(env.DB, USER_A, { sessionDate: "2026-08-10" });
			await getOrCreateSession(env.DB, USER_B, { sessionDate: "2026-08-11" });

			const monthA = await getSessionsByMonth(env.DB, USER_A, 2026, 8);
			expect(monthA.map((s) => s.user_id)).toEqual([USER_A]);

			const recentA = await getRecentSessions(env.DB, USER_A, 10);
			expect(recentA.map((s) => s.user_id)).toEqual([USER_A]);

			const recentB = await getRecentSessions(env.DB, USER_B, 10);
			expect(recentB.map((s) => s.user_id)).toEqual([USER_B]);
		});

		it("does not update another user's session", async () => {
			const { session: b } = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
				goal: "元の目的",
			});
			await updateSession(env.DB, USER_A, b.id, { goal: "書き換え" });
			const reloaded = await getSessionById(env.DB, USER_B, b.id);
			expect(reloaded?.goal).toBe("元の目的");
		});

		it("does not delete another user's session", async () => {
			const { session: b } = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
			});
			expect(await deleteSession(env, USER_A, b.id)).toBe(false);
			expect(await getSessionById(env.DB, USER_B, b.id)).not.toBeNull();
		});

		it("assertSessionOwned reflects the owner", async () => {
			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			expect(await assertSessionOwned(env.DB, USER_A, a.id)).toBe(true);
			expect(await assertSessionOwned(env.DB, USER_B, a.id)).toBe(false);
		});
	});

	describe("records (child tables)", () => {
		it("rejects creating a session exercise under another user's session", async () => {
			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const { exercise } = await registerExercise(env.DB, {
				name: "ベンチプレス",
			});
			await expect(
				createSessionExercise(env.DB, USER_B, {
					sessionId: a.id,
					exerciseId: exercise.id,
				}),
			).rejects.toThrow();
		});

		it("does not update or delete another user's session exercise", async () => {
			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const { exercise } = await registerExercise(env.DB, {
				name: "ベンチプレス",
			});
			const se = await createSessionExercise(env.DB, USER_A, {
				sessionId: a.id,
				exerciseId: exercise.id,
				notes: "元のメモ",
			});

			expect(
				await updateSessionExercise(env.DB, USER_B, se.id, {
					status: "skipped",
				}),
			).toBeNull();
			expect(await deleteSessionExercise(env.DB, USER_B, se.id)).toBe(false);

			const reloaded = await getSessionDetail(env.DB, USER_A, a.id);
			expect(reloaded?.exercises[0]?.sessionExercise.status).toBe("completed");
			expect(reloaded?.exercises[0]?.sessionExercise.notes).toBe("元のメモ");
		});

		it("rejects creating or replacing sets on another user's session exercise", async () => {
			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const { exercise } = await registerExercise(env.DB, {
				name: "ベンチプレス",
			});
			const se = await createSessionExercise(env.DB, USER_A, {
				sessionId: a.id,
				exerciseId: exercise.id,
			});
			await replaceSets(env.DB, USER_A, se.id, [{ reps: 10, weightValue: 60 }]);

			await expect(
				createSet(env.DB, USER_B, {
					sessionExerciseId: se.id,
					setOrder: 2,
					reps: 5,
				}),
			).rejects.toThrow();
			await expect(
				replaceSets(env.DB, USER_B, se.id, [{ reps: 99 }]),
			).rejects.toThrow();
			await deleteSetsBySessionExercise(env.DB, USER_B, se.id);

			const detail = await getSessionDetail(env.DB, USER_A, a.id);
			expect(detail?.exercises[0]?.sets).toHaveLength(1);
			expect(detail?.exercises[0]?.sets[0].reps).toBe(10);
		});
	});

	describe("queries", () => {
		it("does not return another user's session detail", async () => {
			const { session: b } = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-15",
			});
			expect(await getSessionDetail(env.DB, USER_A, b.id)).toBeNull();
		});

		it("scopes history to the user", async () => {
			await getOrCreateSession(env.DB, USER_A, { sessionDate: "2026-08-15" });
			await getOrCreateSession(env.DB, USER_B, { sessionDate: "2026-08-16" });

			expect(await getHistory(env.DB, USER_B)).toHaveLength(1);
			const historyA = await getHistory(env.DB, USER_A);
			expect(historyA).toHaveLength(1);
			expect(historyA[0].session.user_id).toBe(USER_A);
		});

		it("separates exercise aggregates per user on a shared exercise", async () => {
			const { exercise } = await registerExercise(env.DB, {
				name: "ベンチプレス",
				category: "strength",
			});

			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const seA = await createSessionExercise(env.DB, USER_A, {
				sessionId: a.id,
				exerciseId: exercise.id,
			});
			await replaceSets(env.DB, USER_A, seA.id, [
				{ reps: 10, weightValue: 60, weightUnit: "kg" },
			]);

			const { session: b } = await getOrCreateSession(env.DB, USER_B, {
				sessionDate: "2026-08-16",
			});
			const seB = await createSessionExercise(env.DB, USER_B, {
				sessionId: b.id,
				exerciseId: exercise.id,
			});
			await replaceSets(env.DB, USER_B, seB.id, [
				{ reps: 10, weightValue: 999, weightUnit: "kg" },
			]);

			const statsA = await getExerciseStats(env.DB, USER_A, exercise.id);
			expect(statsA?.totalSessions).toBe(1);
			expect(statsA?.maxWeight?.value).toBe(60);
			expect(statsA?.sessionSummaries).toHaveLength(1);

			const statsB = await getExerciseStats(env.DB, USER_B, exercise.id);
			expect(statsB?.totalSessions).toBe(1);
			expect(statsB?.maxWeight?.value).toBe(999);
		});
	});

	describe("session photos", () => {
		it("namespaces the R2 key by user", async () => {
			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const stored = await storeSessionPhoto(env, USER_A, a, JPEG);
			expect(stored.ok).toBe(true);
			if (!stored.ok) return;
			expect(stored.photo.r2_key).toBe(
				`users/${USER_A}/sessions/2026-08-15/${a.id}/${stored.photo.id}.jpg`,
			);
		});

		it("does not expose or delete another user's photo", async () => {
			const { session: a } = await getOrCreateSession(env.DB, USER_A, {
				sessionDate: "2026-08-15",
			});
			const stored = await storeSessionPhoto(env, USER_A, a, JPEG);
			if (!stored.ok) throw new Error(stored.error);

			expect(await listSessionPhotos(env.DB, USER_B, a.id)).toHaveLength(0);
			expect(
				await getSessionPhoto(env.DB, USER_B, a.id, stored.photo.id),
			).toBeNull();
			expect(await deleteSessionPhoto(env, USER_B, a.id, stored.photo.id)).toBe(
				false,
			);

			expect(await listSessionPhotos(env.DB, USER_A, a.id)).toHaveLength(1);
			expect(await env.PHOTOS.get(stored.photo.r2_key)).not.toBeNull();
		});
	});
});
