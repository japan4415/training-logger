import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env.js";
import { registerSessionViews } from "../../src/views/sessions-list.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

const app = new Hono<{ Bindings: Bindings }>();
registerSessionViews(app);

/** Helper to make requests against the test app */
async function request(
	path: string,
	options?: { headers?: Record<string, string> },
): Promise<Response> {
	const req = new Request(`http://localhost${path}`, {
		headers: options?.headers,
	});
	return app.fetch(req, env);
}

/** Seed a minimal session with exercises for testing */
async function seedTestData(db: D1Database): Promise<void> {
	// Create exercises
	await db.batch([
		db
			.prepare(
				"INSERT INTO exercises (id, name, category, equipment, target_muscles) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(1, "ベンチプレス", "strength", null, "胸, 三頭筋"),
		db
			.prepare(
				"INSERT INTO exercises (id, name, category, equipment, target_muscles) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(2, "ウォーキング", "cardio", "トレッドミル", null),
		db
			.prepare(
				"INSERT INTO exercises (id, name, category, equipment, target_muscles) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(3, "レッグレイズ", "strength", null, "腹筋"),
	]);

	// Create sessions
	await db.batch([
		db
			.prepare(
				"INSERT INTO workout_sessions (id, session_date, goal, body_condition) VALUES (?, ?, ?, ?)",
			)
			.bind(1, "2026-08-15", "上半身", "普通"),
		db
			.prepare(
				"INSERT INTO workout_sessions (id, session_date, goal, body_condition) VALUES (?, ?, ?, ?)",
			)
			.bind(2, "2026-08-16", "下半身 + 有酸素", "良好"),
		db
			.prepare(
				"INSERT INTO workout_sessions (id, session_date, goal, body_condition) VALUES (?, ?, ?, ?)",
			)
			.bind(3, "2026-07-10", "テスト7月", null),
	]);

	// Session 1 exercises
	await db.batch([
		db
			.prepare(
				"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(1, 1, 1, 1, "completed", null, null),
		db
			.prepare(
				"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(2, 1, 2, 2, "completed", null, null),
	]);

	// Session 2 exercises (with plan vs actual and form cues)
	await db.batch([
		db
			.prepare(
				"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(3, 2, 2, 1, "completed", null, null),
		db
			.prepare(
				"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status, equipment_note, form_cues) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(4, 2, 3, 2, "completed", null, "肩を上げない\n足を下げると浮く"),
	]);

	// Sets for session 1 - strength
	await db.batch([
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(1, 1, 0, 10, 60, "kg"),
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps, weight_value, weight_unit) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(1, 2, 0, 10, 55, "kg"),
	]);

	// Sets for session 1 - cardio
	await db
		.prepare(
			"INSERT INTO sets (session_exercise_id, set_order, is_planned, duration_minutes, speed_min, speed_max, incline_percent) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(2, 1, 0, 10, 3.5, 5.0, 0.5)
		.run();

	// Sets for session 2 - cardio
	await db
		.prepare(
			"INSERT INTO sets (session_exercise_id, set_order, is_planned, duration_minutes, speed_min, speed_max, incline_percent) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(3, 1, 0, 10, 4.0, 5.0, 0.5)
		.run();

	// Sets for session 2 - planned vs actual (leg raise)
	await db.batch([
		// Planned
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps) VALUES (?, ?, ?, ?)",
			)
			.bind(4, 1, 1, 20),
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps) VALUES (?, ?, ?, ?)",
			)
			.bind(4, 2, 1, 20),
		// Actual
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps) VALUES (?, ?, ?, ?)",
			)
			.bind(4, 1, 0, 20),
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps) VALUES (?, ?, ?, ?)",
			)
			.bind(4, 2, 0, 10),
		db
			.prepare(
				"INSERT INTO sets (session_exercise_id, set_order, is_planned, reps) VALUES (?, ?, ?, ?)",
			)
			.bind(4, 3, 0, 10),
	]);
}

describe("Session views", () => {
	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		await seedTestData(env.DB);
	});

	describe("GET / (session list)", () => {
		it("returns full HTML page with sessions for specified month", async () => {
			const res = await request("/?month=2026-08");
			expect(res.status).toBe(200);

			const html = await res.text();
			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain("training-logger");
			expect(html).toContain("2026年8月");
			// Should contain both August sessions
			expect(html).toContain("2026/08/15");
			expect(html).toContain("2026/08/16");
			expect(html).toContain("上半身");
			expect(html).toContain("下半身 + 有酸素");
			// Should NOT contain July session
			expect(html).not.toContain("2026/07/10");
		});

		it("includes exercise count and names in session cards", async () => {
			const res = await request("/?month=2026-08");
			const html = await res.text();
			// Session 1 has 2 exercises
			expect(html).toContain("2種目");
			expect(html).toContain("ベンチプレス");
			expect(html).toContain("ウォーキング");
		});

		it("shows body condition in session cards", async () => {
			const res = await request("/?month=2026-08");
			const html = await res.text();
			expect(html).toContain("体調: 普通");
			expect(html).toContain("体調: 良好");
		});

		it("shows empty message for month with no sessions", async () => {
			const res = await request("/?month=2026-01");
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("この月のセッションはありません");
		});

		it("returns 400 for invalid month parameter", async () => {
			const res = await request("/?month=invalid");
			expect(res.status).toBe(400);
		});

		it("returns partial HTML for htmx request (HX-Request header)", async () => {
			const res = await request("/?month=2026-08", {
				headers: { "HX-Request": "true" },
			});
			expect(res.status).toBe(200);

			const html = await res.text();
			// Partial should NOT contain full page elements
			expect(html).not.toContain("<!DOCTYPE html>");
			expect(html).not.toContain("<html");
			// But SHOULD contain session data
			expect(html).toContain("2026年8月");
			expect(html).toContain("2026/08/15");
		});

		it("includes month navigation with correct links", async () => {
			const res = await request("/?month=2026-08");
			const html = await res.text();
			expect(html).toContain("month=2026-07");
			expect(html).toContain("month=2026-09");
			expect(html).toContain("前月");
			expect(html).toContain("次月");
		});

		it("handles December year boundary correctly", async () => {
			const res = await request("/?month=2026-12");
			const html = await res.text();
			expect(html).toContain("month=2026-11"); // prev
			expect(html).toContain("month=2027-01"); // next
		});
	});

	describe("GET /sessions/:id (session detail)", () => {
		it("returns session detail with exercises and sets", async () => {
			const res = await request("/sessions/1");
			expect(res.status).toBe(200);

			const html = await res.text();
			expect(html).toContain("2026/08/15");
			expect(html).toContain("上半身");
			expect(html).toContain("体調:");
			expect(html).toContain("普通");
			// Exercises
			expect(html).toContain("ベンチプレス");
			expect(html).toContain("ウォーキング");
		});

		it("displays strength sets correctly", async () => {
			const res = await request("/sessions/1");
			const html = await res.text();
			expect(html).toContain("10x60kg");
			expect(html).toContain("10x55kg");
		});

		it("displays cardio sets correctly", async () => {
			const res = await request("/sessions/2");
			const html = await res.text();
			expect(html).toContain("10分");
			expect(html).toContain("4~5km/h");
			expect(html).toContain("0.5%");
		});

		it("displays planned vs actual sets", async () => {
			const res = await request("/sessions/2");
			const html = await res.text();
			expect(html).toContain("計画:");
			expect(html).toContain("実績:");
		});

		it("displays form cues as tooltip", async () => {
			const res = await request("/sessions/2");
			const html = await res.text();
			expect(html).toContain("肩を上げない");
			expect(html).toContain("[cue]");
		});

		it("shows status icons for exercises", async () => {
			const res = await request("/sessions/1");
			const html = await res.text();
			// All exercises in test data are completed
			expect(html).toContain("status-completed");
		});

		it("includes prev/next session navigation", async () => {
			const res = await request("/sessions/1");
			const html = await res.text();
			// Session 1 (2026-08-15): no prev, next is session 2 (2026-08-16)
			expect(html).toContain("/sessions/2");
		});

		it("returns 404 for non-existent session", async () => {
			const res = await request("/sessions/9999");
			expect(res.status).toBe(404);
			const html = await res.text();
			expect(html).toContain("セッションが見つかりません");
		});

		it("returns 400 for invalid session ID", async () => {
			const res = await request("/sessions/abc");
			expect(res.status).toBe(400);
		});

		it("displays target muscles summary for session with target_muscles", async () => {
			const res = await request("/sessions/1");
			const html = await res.text();
			// Session 1 has ベンチプレス (target_muscles: "胸, 三頭筋") and ウォーキング (null)
			expect(html).toContain("鍛えた部位:");
			expect(html).toContain("胸");
			expect(html).toContain("三頭筋");
		});

		it("displays target muscles from multiple exercises with deduplication", async () => {
			const res = await request("/sessions/2");
			const html = await res.text();
			// Session 2 has ウォーキング (null) and レッグレイズ (target_muscles: "腹筋")
			expect(html).toContain("鍛えた部位:");
			expect(html).toContain("腹筋");
		});

		it("does not display target muscles section when no exercises have target_muscles", async () => {
			// Create a session with only exercises that have null target_muscles
			const db = env.DB;
			await db
				.prepare(
					"INSERT INTO workout_sessions (id, session_date, goal) VALUES (?, ?, ?)",
				)
				.bind(10, "2026-09-01", "テスト")
				.run();
			await db
				.prepare(
					"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(10, 10, 2, 1, "completed")
				.run();
			const res = await request("/sessions/10");
			const html = await res.text();
			expect(html).not.toContain("鍛えた部位:");
		});

		it("excludes skipped and planned exercises from target muscles summary", async () => {
			const db = env.DB;
			// Create a session with mixed statuses
			await db
				.prepare(
					"INSERT INTO workout_sessions (id, session_date, goal) VALUES (?, ?, ?)",
				)
				.bind(20, "2026-10-01", "ステータステスト")
				.run();
			// Exercise with target_muscles, status=skipped
			await db
				.prepare(
					"INSERT INTO exercises (id, name, category, target_muscles) VALUES (?, ?, ?, ?)",
				)
				.bind(20, "スキップ種目", "strength", "肩")
				.run();
			await db
				.prepare(
					"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(20, 20, 20, 1, "skipped")
				.run();
			// Exercise with target_muscles, status=planned
			await db
				.prepare(
					"INSERT INTO exercises (id, name, category, target_muscles) VALUES (?, ?, ?, ?)",
				)
				.bind(21, "計画種目", "strength", "腕")
				.run();
			await db
				.prepare(
					"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(21, 20, 21, 2, "planned")
				.run();
			// Exercise with target_muscles, status=completed
			await db
				.prepare(
					"INSERT INTO exercises (id, name, category, target_muscles) VALUES (?, ?, ?, ?)",
				)
				.bind(22, "完了種目", "strength", "脚")
				.run();
			await db
				.prepare(
					"INSERT INTO session_exercises (id, session_id, exercise_id, display_order, status) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(22, 20, 22, 3, "completed")
				.run();

			const res = await request("/sessions/20");
			const html = await res.text();
			// Only completed exercise's target_muscles should appear
			expect(html).toContain("鍛えた部位:");
			expect(html).toContain("脚");
			// Skipped and planned exercises' target_muscles should NOT appear in the summary tags
			expect(html).not.toContain('<span class="target-muscle-tag">肩</span>');
			expect(html).not.toContain('<span class="target-muscle-tag">腕</span>');
		});
	});
});
