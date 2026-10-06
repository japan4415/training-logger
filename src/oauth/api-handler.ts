/**
 * Issue #66 Phase 4: `/mcp` の OAuth 認可付き API ハンドラ。
 *
 * `OAuthProvider` は `/mcp` へのリクエストを access token 検証後にこの
 * ハンドラへ渡す。`ctx.props` には `/authorize` で束縛した内部 `users.id`、
 * `ctx.auth` には検証済みトークンの情報（scope など）が入る。
 *
 * ライブラリは `requiredScopes` を強制しないため、認可判定はここで行う。
 *
 *   1. baseline scope（`mcp:read` / `mcp:write` のいずれか）が無ければ 403。
 *   2. `tools/call` はツール単位の必要 scope（`src/mcp/scopes.ts`）を検査し、
 *      不足していれば 403 `insufficient_scope` で step-up を促す。
 *   3. `users.status` / `users.role` を毎リクエスト D1 照会する。disabled か
 *      不在なら 401、role は owner 限定ツールの判定に使って `createMcpServer`
 *      へ渡す。
 */

import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getUserAccess } from "../db/users.js";
import type { Bindings } from "../env.js";
import type { McpContext } from "../mcp/context.js";
import { requiredScopeForBody } from "../mcp/scopes.js";
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

/** scope 不足の 403 応答を組み立てる。token 情報が無くても challenge を返せるようにする。 */
function scopeChallenge(
	auth: OAuthResourceAuth | undefined,
	scope: readonly string[],
	required: readonly string[],
): Response {
	return insufficientScope(
		auth ?? { token: "", audience: MCP_RESOURCE, scope: [...scope] },
		[...required],
	);
}

/**
 * リクエストボディの `tools/call` から必要 scope を読み取る。
 * ボディは clone して読むため、transport には元のリクエストを渡す。
 */
async function readToolScope(request: Request): Promise<string | null> {
	if (request.method !== "POST") return null;
	try {
		return requiredScopeForBody(await request.clone().json());
	} catch {
		return null;
	}
}

/** MCP の Streamable HTTP リクエストを 1 リクエスト 1 McpServer で処理する。 */
async function handleMcpRequest(
	request: Request,
	env: Bindings,
	ctx: McpContext,
): Promise<Response> {
	if (request.method !== "POST") {
		// ステートレス構成のため SSE ストリームは提供しない（仕様上 GET は 405 でよい）。
		return new Response("Method Not Allowed", { status: 405 });
	}
	try {
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		const server = createMcpServer(env, ctx);
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
			return scopeChallenge(ctx.auth, scope, RESOURCE_REQUIRED_SCOPES);
		}

		// ツール単位の scope。不足時は step-up を促す 403 を返し、ツール層へ
		// 到達させない（ツール層にも同じ表で二重のガードがある）。
		const requiredScope = await readToolScope(request);
		if (requiredScope && !scope.includes(requiredScope)) {
			return scopeChallenge(ctx.auth, scope, [requiredScope]);
		}

		const access = await getUserAccess(env.DB, userId);
		if (access?.status !== "active") {
			return jsonError(401, "account_inactive");
		}

		return handleMcpRequest(request, env, {
			userId,
			role: access.role,
			scopes: scope,
		});
	},
};
