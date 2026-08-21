import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bindings } from "../env.js";
import { registerExerciseTools } from "./tools/exercises.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerWorkoutTools } from "./tools/workouts.js";

/**
 * Create a new McpServer instance configured for training-logger.
 *
 * Called once per request (stateless design).
 *
 * @param env - Worker bindings (DB etc.) passed to each tool registrar.
 */
export function createMcpServer(env: Bindings): McpServer {
	const server = new McpServer({
		name: "training-logger",
		version: "0.1.0",
	});

	registerExerciseTools(server, env);
	registerWorkoutTools(server, env);
	registerHistoryTools(server, env);

	return server;
}
