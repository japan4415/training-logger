/**
 * Issue #66 Phase 4: OAuth 2.1 の `/authorize`（同意画面）。
 *
 * Cloudflare Access の deny-by-default ミドルウェア（`registerAccessAuth`）が
 * 先に走り、`/authorize` は Access JWT 必須のまま保たれる。ここでは検証済み
 * Access `sub` から内部 `users.id` を解決し、`completeAuthorization` の props に
 * 内部 `userId` を束縛する。
 *
 * 同意画面はスキップさせない（未知クライアントを自動承認しない）。承認 POST は
 * consent handle と Access `sub` に束縛した CSRF トークン、加えて Fetch Metadata
 * の `Sec-Fetch-Site` 検査（ミドルウェア）で守る。応答には
 * `Content-Security-Policy: frame-ancestors 'none'` を付ける。
 */

import {
	AuthorizationError,
	CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireUserId } from "../security/auth.js";
import { ConsentErrorPage, ConsentPage } from "../views/consent.js";
import type { McpAuthProps } from "./api-handler.js";
import {
	allowedRedirectHosts,
	isAllowedAuthorizationRequest,
} from "./config.js";
import {
	consentCsrfSecret,
	createConsentCsrfToken,
	timingSafeEqual,
} from "./csrf.js";

const CONSENT_CSP = "frame-ancestors 'none'";

function htmlWithHeaders(
	c: Context<AppEnv>,
	element: unknown,
	status: number,
	headers: Headers,
): Response {
	headers.set("Content-Security-Policy", CONSENT_CSP);
	headers.set("Cache-Control", "no-store");
	return c.html(
		// Hono JSX の要素は c.html が描画する。表示する値は JSX が自動エスケープする。
		element as never,
		status as never,
		Object.fromEntries(headers) as never,
	);
}

function errorPage(
	c: Context<AppEnv>,
	status: number,
	message: string,
): Response {
	return htmlWithHeaders(
		c,
		<ConsentErrorPage message={message} />,
		status,
		new Headers(),
	);
}

/**
 * パース / 同意の失敗を処理する。redirect が安全に作れる（クライアントと
 * redirect_uri が検証済み）ときだけクライアントへ返し、それ以外はローカル表示する。
 */
function handleAuthorizeError(c: Context<AppEnv>, error: unknown): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo) {
			return new Response(null, {
				status: 302,
				headers: {
					Location: error.redirectTo,
					"Content-Security-Policy": CONSENT_CSP,
					"Cache-Control": "no-store",
				},
			});
		}
		return errorPage(c, 400, error.description);
	}
	if (error instanceof CimdFetchError) {
		return errorPage(
			c,
			400,
			"クライアントのメタデータを取得できませんでした。時間をおいて再度お試しください。",
		);
	}
	throw error;
}

/** CSRF 用の鍵が無い（本番で OAUTH_CONSENT_SECRET 未設定）ときの fail-closed 応答。 */
function settingsMissing(c: Context<AppEnv>): Response {
	return errorPage(
		c,
		503,
		"同意画面のサーバー設定が完了していません。管理者に連絡してください。",
	);
}

export function registerAuthorizeRoutes(app: Hono<AppEnv>): void {
	app.get("/authorize", async (c) => {
		const oauth = c.env.OAUTH_PROVIDER;
		if (!oauth) return errorPage(c, 500, "OAuth プロバイダが利用できません。");
		const subject = c.get("accessSubject");
		if (!subject) return errorPage(c, 401, "認証情報がありません。");

		const secret = consentCsrfSecret(c.env, c.req.url);
		if (!secret) return settingsMissing(c);

		try {
			const request = await oauth.parseAuthRequest(c.req.raw);
			const allowed = allowedRedirectHosts(c.env.OAUTH_ALLOWED_REDIRECT_HOSTS);
			if (!isAllowedAuthorizationRequest(request, allowed)) {
				return errorPage(
					c,
					400,
					"このクライアントの redirect_uri は許可されていません。",
				);
			}
			const details = await oauth.describeConsent(request);
			const consent = await oauth.beginConsent(request);
			const csrfToken = await createConsentCsrfToken(
				subject,
				consent.handle,
				secret,
			);
			return htmlWithHeaders(
				c,
				<ConsentPage
					clientName={details.clientName}
					clientId={details.clientId}
					clientDomain={details.clientDomain}
					redirectUri={details.redirectUri}
					redirectHost={details.redirectHost}
					redirectIsLoopback={details.redirectIsLoopback}
					scopes={details.scope}
					handle={consent.handle}
					csrfToken={csrfToken}
				/>,
				200,
				consent.headers,
			);
		} catch (error) {
			return handleAuthorizeError(c, error);
		}
	});

	app.post("/authorize", async (c) => {
		const oauth = c.env.OAUTH_PROVIDER;
		if (!oauth) return errorPage(c, 500, "OAuth プロバイダが利用できません。");
		const userId = requireUserId(c);
		const subject = c.get("accessSubject");
		if (!subject) return errorPage(c, 401, "認証情報がありません。");

		const secret = consentCsrfSecret(c.env, c.req.url);
		if (!secret) return settingsMissing(c);

		const form = await c.req.formData();
		const handle = String(form.get("handle") ?? "");
		const csrfToken = String(form.get("csrf") ?? "");
		const decision = String(form.get("decision") ?? "");
		if (!handle) {
			return errorPage(
				c,
				400,
				"同意リクエストが見つかりません。最初からやり直してください。",
			);
		}

		const expected = await createConsentCsrfToken(subject, handle, secret);
		if (!timingSafeEqual(csrfToken, expected)) {
			return errorPage(
				c,
				403,
				"CSRF トークンが一致しません。最初からやり直してください。",
			);
		}

		try {
			if (decision !== "approve") {
				const denied = await oauth.denyConsent(c.req.raw, handle);
				denied.headers.set("Content-Security-Policy", CONSENT_CSP);
				return new Response(null, {
					status: 302,
					headers: denied.headers,
				});
			}

			const scopes = form.getAll("scope").map(String);
			const approved = await oauth.approveConsent(c.req.raw, handle, {
				scope: scopes,
			});
			const props: McpAuthProps = { userId };
			const { redirectTo } = await oauth.completeAuthorization({
				request: approved.request,
				userId: String(userId),
				metadata: {},
				scope: approved.request.scope,
				props,
			});
			approved.headers.set("Location", redirectTo);
			approved.headers.set("Content-Security-Policy", CONSENT_CSP);
			return new Response(null, {
				status: 302,
				headers: approved.headers,
			});
		} catch (error) {
			return handleAuthorizeError(c, error);
		}
	});
}
