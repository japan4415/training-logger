/**
 * Issue #66 Phase 4: `/mcp` の OAuth 認可付き API ハンドラ。
 *
 * `OAuthProvider` は `/mcp` へのリクエストを access token 検証後にこの
 * ハンドラへ渡す。`ctx.props` には `/authorize` で束縛した内部 `users.id`、
 * `ctx.auth` には検証済みトークンの情報（scope など）が入る。
 *
 * ライブラリは `requiredScopes` を強制しないため、scope の不足判定と、
 * `users.status` の毎リクエスト照会（disabled なら 401）はここで行う。
 * ツール単位の細かい scope 割当は Phase 4b（p4-mcp-scope）で扱い、ここでは
 * ツール層へ `userId` を渡す口までを作る。
 */

import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getUserStatus } from "../db/users.js";
import type { Bindings } from "../env.js";
import { createMcpServer } from "../mcp/server.js";
import { MCP_RESOURCE, RESOURCE_REQUIRED_SCOPES } from "./config.js";

/** `/authorize` で `completeAuthorization` に束縛する props。 */
export interface McpAuthProps {
	/** アプリ内部の `users.id`（INTEGER）。外部 Access の `sub` ではない。 */
	userId: number;
}

/**
 * `OAuthProvider` が `apiHandler` に渡す実行コンテキスト。
 * `props` / `auth` はライブラリが検証後に注入する。
 */
export type McpApiContext = ExecutionContext<McpAuthProps> & {
	readonly auth?: OAuthResourceAuth;
};

/** `/mcp` で baseline として認める scope（いずれか 1 つでよい）。 */
const BASELINE_SCOPES = ["mcp:read", "mcp:write"] as const;

function hasBaselineScope(scope: readonly string[]): boolean {
	return BASELINE_SCOPES.some((required) => scope.includes(required));
}

function jsonError(status: number, error: string): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function readUserId(props: unknown): number | null {
	if (typeof props !== "object" || props === null) return null;
	const value = (props as { userId?: unknown }).userId;
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** MCP の Streamable HTTP リクエストを 1 リクエスト 1 McpServer で処理する。 */
async function handleMcpRequest(
	request: Request,
	env: Bindings,
	userId: number,
): Promise<Response> {
	if (request.method !== "POST") {
		// ステートレス構成のため SSE ストリームは提供しない（仕様上 GET は 405 でよい）。
		return new Response("Method Not Allowed", { status: 405 });
	}
	try {
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		const server = createMcpServer(env, { userId });
		await server.connect(transport);
		return transport.handleRequest(request);
	} catch {
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32603, message: "Internal error" },
				id: null,
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			},
		);
	}
}

/**
 * `/mcp` の認可済みハンドラ。単体テストから偽の `ctx.props` / `ctx.auth` を
 * 渡せるよう、`OAuthProvider` のオプションとは独立してエクスポートする。
 */
export const mcpApiHandler = {
	async fetch(
		request: Request,
		env: Bindings,
		ctx: McpApiContext,
	): Promise<Response> {
		const userId = readUserId(ctx.props);
		if (userId === null) {
			return jsonError(401, "unauthorized");
		}

		const scope = ctx.auth?.scope ?? [];
		if (!hasBaselineScope(scope)) {
			const auth: OAuthResourceAuth = ctx.auth ?? {
				token: "",
				audience: MCP_RESOURCE,
				scope: [...scope],
			};
			return insufficientScope(auth, [...RESOURCE_REQUIRED_SCOPES]);
		}

		const status = await getUserStatus(env.DB, userId);
		if (status !== "active") {
			return jsonError(401, "account_inactive");
		}

		return handleMcpRequest(request, env, userId);
	},
};
