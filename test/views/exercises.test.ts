import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExercise } from "../../src/db/exercises.js";
import { createSessionExercise, replaceSets } from "../../src/db/records.js";
import { getOrCreateSession } from "../../src/db/sessions.js";
import type { Bindings } from "../../src/env.js";
import { registerExerciseProgressRoutes } from "../../src/views/exercise-progress.js";
import { registerExerciseListRoutes } from "../../src/views/exercises-list.js";
import { applyMigrations, cleanDatabase } from "../db/test-helpers.js";

// Create a fresh Hono app with the exercise view routes
const app = new Hono<{ Bindings: Bindings }>();
registerExerciseListRoutes(app);
registerExerciseProgressRoutes(app);

/**
 * Seed test data for exercise view tests.
 *
 * Exercises:
 *   - ベンチプレス (strength, equipment: バーベル)
 *   - ウォーキング (cardio, equipment: トレッドミル)
 *   - ストレッチボード (flexibility)
 *
 * Sessions:
 *   2026-08-15:
 *     - ベンチプレス: 2 actual sets (10rep/60kg, 8rep/65kg)
 *     - ウォーキング: 1 actual set (10min, 3.5~5.0km/h, incline 0.5%)
 *
 *   2026-08-16:
 *     - ベンチプレス: 3 actual sets (10rep/60kg, 8rep/70kg, 6rep/75kg)
 *     - ストレッチボード: 1 actual set (20 degrees)
 */
async function seedTestData(): Promise<{
	benchId: number;
	walkingId: number;
	stretchId: number;
}> {
	const { exercise: bench } = await registerExercise(env.DB, {
		name: "ベンチプレス",
		category: "strength",
		equipment: "バーベル",
		aliases: ["Bench Press"],
	});
	const { exercise: walking } = await registerExercise(env.DB, {
		name: "ウォーキング",
		category: "cardio",
		equipment: "トレッドミル",
	});
	const { exercise: stretch } = await registerExercise(env.DB, {
		name: "ストレッチボード",
		category: "flexibility",
	});

	// Session 1: 2026-08-15
	const { session: s1 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-15",
	});
	const se1bench = await createSessionExercise(env.DB, {
		sessionId: s1.id,
		exerciseId: bench.id,
	});
	await replaceSets(env.DB, se1bench.id, [
		{ reps: 10, weightValue: 60, weightUnit: "kg" },
		{ reps: 8, weightValue: 65, weightUnit: "kg" },
	]);
	const se1walk = await createSessionExercise(env.DB, {
		sessionId: s1.id,
		exerciseId: walking.id,
	});
	await replaceSets(env.DB, se1walk.id, [
		{
			durationMinutes: 10,
			speedMin: 3.5,
			speedMax: 5.0,
			inclinePercent: 0.5,
		},
	]);

	// Session 2: 2026-08-16
	const { session: s2 } = await getOrCreateSession(env.DB, {
		sessionDate: "2026-08-16",
	});
	const se2bench = await createSessionExercise(env.DB, {
		sessionId: s2.id,
		exerciseId: bench.id,
	});
	await replaceSets(env.DB, se2bench.id, [
		{ reps: 10, weightValue: 60, weightUnit: "kg" },
		{ reps: 8, weightValue: 70, weightUnit: "kg" },
		{ reps: 6, weightValue: 75, weightUnit: "kg" },
	]);
	const se2stretch = await createSessionExercise(env.DB, {
		sessionId: s2.id,
		exerciseId: stretch.id,
	});
	await replaceSets(env.DB, se2stretch.id, [{ angleDegrees: 20 }]);

	return {
		benchId: bench.id,
		walkingId: walking.id,
		stretchId: stretch.id,
	};
}

describe("exercise views", () => {
	let benchId: number;
	let walkingId: number;
	let stretchId: number;

	beforeAll(async () => {
		await applyMigrations(env.DB);
	});

	beforeEach(async () => {
		await cleanDatabase(env.DB);
		const data = await seedTestData();
		benchId = data.benchId;
		walkingId = data.walkingId;
		stretchId = data.stretchId;
	});

	// -----------------------------------------------------------------------
	// Exercise List (GET /exercises)
	// -----------------------------------------------------------------------

	describe("GET /exercises", () => {
		it("should return exercise list with all exercises", async () => {
			const res = await app.request("/exercises", {}, { DB: env.DB });
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("ベンチプレス");
			expect(html).toContain("ウォーキング");
			expect(html).toContain("ストレッチボード");
		});

		it("should include category labels", async () => {
			const res = await app.request("/exercises", {}, { DB: env.DB });
			const html = await res.text();
			expect(html).toContain("筋力");
			expect(html).toContain("有酸素");
			expect(html).toContain("柔軟");
		});

		it("should include equipment info", async () => {
			const res = await app.request("/exercises", {}, { DB: env.DB });
			const html = await res.text();
			expect(html).toContain("バーベル");
			expect(html).toContain("トレッドミル");
		});

		it("should include session count and last performed date", async () => {
			const res = await app.request("/exercises", {}, { DB: env.DB });
			const html = await res.text();
			// ベンチプレス appears in 2 sessions
			expect(html).toContain("回数: 2");
			// Last performed date for ベンチプレス
			expect(html).toContain("2026-08-16");
		});

		it("should filter by category", async () => {
			const res = await app.request(
				"/exercises?category=strength",
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			expect(html).toContain("ベンチプレス");
			expect(html).not.toContain("ウォーキング");
			expect(html).not.toContain("ストレッチボード");
		});

		it("should return full HTML for normal request", async () => {
			const res = await app.request("/exercises", {}, { DB: env.DB });
			const html = await res.text();
			// Should contain title (from Layout)
			expect(html).toContain("種目一覧");
		});

		it("should return partial HTML for htmx request", async () => {
			const res = await app.request(
				"/exercises?category=cardio",
				{ headers: { "HX-Request": "true" } },
				{ DB: env.DB },
			);
			const html = await res.text();
			// Should contain exercise data
			expect(html).toContain("ウォーキング");
			// Should NOT contain <title> (no Layout wrapper)
			expect(html).not.toContain("<title>");
		});

		it("should show empty message when no exercises in category", async () => {
			await cleanDatabase(env.DB);
			const res = await app.request("/exercises", {}, { DB: env.DB });
			const html = await res.text();
			expect(html).toContain("種目が登録されていません");
		});

		it("should link to exercise progress pages", async () => {
			const res = await app.request("/exercises", {}, { DB: env.DB });
			const html = await res.text();
			expect(html).toContain(`/exercises/${benchId}`);
		});
	});

	// -----------------------------------------------------------------------
	// Exercise Progress (GET /exercises/:id)
	// -----------------------------------------------------------------------

	describe("GET /exercises/:id", () => {
		it("should return 404 for non-existent exercise", async () => {
			const res = await app.request("/exercises/9999", {}, { DB: env.DB });
			expect(res.status).toBe(404);
		});

		it("should return 400 for invalid ID", async () => {
			const res = await app.request("/exercises/abc", {}, { DB: env.DB });
			expect(res.status).toBe(400);
		});

		it("should display exercise info for strength exercise", async () => {
			const res = await app.request(
				`/exercises/${benchId}`,
				{},
				{ DB: env.DB },
			);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("ベンチプレス");
			expect(html).toContain("筋力");
			expect(html).toContain("バーベル");
		});

		it("should display aliases", async () => {
			const res = await app.request(
				`/exercises/${benchId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			expect(html).toContain("Bench Press");
		});

		it("should embed weight chart data for strength exercise", async () => {
			const res = await app.request(
				`/exercises/${benchId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();

			// Should contain the chart-data script tag with JSON
			expect(html).toContain('id="chart-data"');

			// Extract the JSON from the chart-data script tag
			const match = html.match(
				/<script[^>]*id="chart-data"[^>]*>([\s\S]*?)<\/script>/,
			);
			expect(match).not.toBeNull();

			const chartData = JSON.parse(match?.[1]);
			expect(chartData.type).toBe("weight");
			expect(chartData.labels).toContain("2026-08-15");
			expect(chartData.labels).toContain("2026-08-16");
			expect(chartData.datasets.length).toBeGreaterThan(0);

			// Check that the kg dataset contains correct max weights
			const kgDataset = chartData.datasets.find(
				(ds: { unit: string }) => ds.unit === "kg",
			);
			expect(kgDataset).toBeDefined();
			// Session 2026-08-15: max = 65kg, Session 2026-08-16: max = 75kg
			const idx15 = chartData.labels.indexOf("2026-08-15");
			const idx16 = chartData.labels.indexOf("2026-08-16");
			expect(kgDataset.values[idx15]).toBe(65);
			expect(kgDataset.values[idx16]).toBe(75);
		});

		it("should embed speed chart data for cardio exercise", async () => {
			const res = await app.request(
				`/exercises/${walkingId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();

			const match = html.match(
				/<script[^>]*id="chart-data"[^>]*>([\s\S]*?)<\/script>/,
			);
			expect(match).not.toBeNull();

			const chartData = JSON.parse(match?.[1]);
			expect(chartData.type).toBe("speed");
			expect(chartData.labels).toContain("2026-08-15");

			// Max speed is 5.0 km/h
			const speedDataset = chartData.datasets.find(
				(ds: { unit: string }) => ds.unit === "km/h",
			);
			expect(speedDataset).toBeDefined();
			expect(speedDataset.values[0]).toBe(5.0);
		});

		it("should show empty chart message for flexibility exercise", async () => {
			const res = await app.request(
				`/exercises/${stretchId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			expect(html).toContain("データがありません");
		});

		it("should display history table with set details", async () => {
			const res = await app.request(
				`/exercises/${benchId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			// History should show session dates
			expect(html).toContain("2026-08-16");
			expect(html).toContain("2026-08-15");
			// Should show weight values in set descriptions
			expect(html).toContain("75kg");
			expect(html).toContain("65kg");
		});

		it("should include Chart.js CDN reference in full page", async () => {
			const res = await app.request(
				`/exercises/${benchId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			expect(html).toContain("cdn.jsdelivr.net/npm/chart.js");
			expect(html).toContain("/js/chart-init.js");
		});

		it("should include period filter buttons", async () => {
			const res = await app.request(
				`/exercises/${benchId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			expect(html).toContain("1M");
			expect(html).toContain("3M");
			expect(html).toContain("6M");
			expect(html).toContain("全期間");
		});

		it("should return partial HTML for htmx request", async () => {
			const res = await app.request(
				`/exercises/${benchId}?period=3m`,
				{ headers: { "HX-Request": "true" } },
				{ DB: env.DB },
			);
			expect(res.status).toBe(200);
			const html = await res.text();
			// Should contain chart data
			expect(html).toContain('id="chart-data"');
			// Should contain re-init script for htmx
			expect(html).toContain("initProgressChart");
			// Should NOT contain Layout elements
			expect(html).not.toContain("<title>");
		});

		it("should display cardio history with speed info", async () => {
			const res = await app.request(
				`/exercises/${walkingId}`,
				{},
				{ DB: env.DB },
			);
			const html = await res.text();
			expect(html).toContain("2026-08-15");
			expect(html).toContain("3.5~5km/h");
		});

		it("should handle period=all showing all data", async () => {
			const res = await app.request(
				`/exercises/${benchId}?period=all`,
				{},
				{ DB: env.DB },
			);
			expect(res.status).toBe(200);
			const html = await res.text();
			// Both sessions should be present
			expect(html).toContain("2026-08-15");
			expect(html).toContain("2026-08-16");
		});
	});
});
