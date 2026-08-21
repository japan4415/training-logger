import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bindings } from "../env.js";

/**
 * Create a new McpServer instance configured for training-logger.
 *
 * Called once per request (stateless design).
 * Tools will be registered here as they are implemented in future issues.
 *
 * @param _env - Worker bindings (DB etc.). Currently unused but required
 *   for upcoming tool registrations that need D1 access.
 */
export function createMcpServer(_env: Bindings): McpServer {
	const server = new McpServer({
		name: "training-logger",
		version: "0.1.0",
	});

	// Tool registration will be added here (using _env.DB):
	// - search_exercises
	// - register_exercise
	// - log_workout
	// - update_workout
	// - delete_workout
	// - get_history

	return server;
}
