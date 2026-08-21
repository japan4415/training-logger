import type { Hono } from "hono";
import type { Bindings } from "../env.js";
import { getExercise, listExercises } from "./exercises.js";
import { getSession, listSessions } from "./sessions.js";
import { getExerciseStatsHandler } from "./stats.js";

/**
 * Register all REST API routes on the given Hono app.
 *
 * Routes:
 *   GET /api/sessions          - Session list (month filter, pagination)
 *   GET /api/sessions/:id      - Session detail
 *   GET /api/exercises         - Exercise list (category / search filter)
 *   GET /api/exercises/:id     - Exercise detail
 *   GET /api/exercises/:id/stats - Exercise statistics
 */
export function registerApiRoutes(app: Hono<{ Bindings: Bindings }>): void {
	// Sessions
	app.get("/api/sessions", listSessions);
	app.get("/api/sessions/:id", getSession);

	// Exercises  (stats route first — more specific path)
	app.get("/api/exercises/:id/stats", getExerciseStatsHandler);
	app.get("/api/exercises", listExercises);
	app.get("/api/exercises/:id", getExercise);
}
