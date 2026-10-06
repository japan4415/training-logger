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
	type AuthorizationErrorCode,
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
	isAllowedRedirectUri,
} from "./config.js";
import {
	consentCsrfSecret,
	createConsentCsrfToken,
	timingSafeEqual,
} from "./csrf.js";

const CONSENT_CSP = "frame-ancestors 'none'";

/** 認可リクエストの検証エラーを日本語で説明する（ライブラリの英語 description は出さない）。 */
const AUTHORIZE_ERROR_MESSAGES: Readonly<
	Record<AuthorizationErrorCode, string>
> = {
	invalid_request:
		"認可リクエストの内容が正しくないため、続行できませんでした。",
	invalid_target:
		"アクセス先（resource）が正しくないため、続行できませんでした。",
	unauthorized_client: "このクライアントは許可されていません。",
	access_denied: "アクセスが拒否されました。",
	unsupported_response_type: "この応答方式には対応していません。",
	invalid_scope: "要求された権限が正しくありません。",
	server_error: "サーバー側のエラーで続行できませんでした。",
	temporarily_unavailable:
		"一時的に利用できません。時間をおいて再度お試しください。",
};

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
 * パース / 同意の失敗を処理する。redirect が安全に作れる（redirect_uri / ホストが
 * 許可リストに載っている）ときだけクライアントへ返し、それ以外はローカル表示する。
 *
 * `parseAuthRequest` は PKCE / resource / response_type の検証エラーでも
 * `redirectTo` を組み立てる（許可リスト判定より前）。ここでホストを必ず検証し、
 * 許可リスト外のホストへの 302（オープンリダイレクト）を防ぐ。
 */
function handleAuthorizeError(
	c: Context<AppEnv>,
	error: unknown,
	allowed: Set<string>,
): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo && isAllowedRedirectUri(error.redirectTo, allowed)) {
			return new Response(null, {
				status: 302,
				headers: {
					Location: error.redirectTo,
					"Content-Security-Policy": CONSENT_CSP,
					"Cache-Control": "no-store",
				},
			});
		}
		return errorPage(
			c,
			400,
			`${AUTHORIZE_ERROR_MESSAGES[error.code] ?? "認可できませんでした。"}（${error.code}）`,
		);
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

		const allowed = allowedRedirectHosts(c.env.OAUTH_ALLOWED_REDIRECT_HOSTS);
		try {
			const request = await oauth.parseAuthRequest(c.req.raw);
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
					accountEmail={c.get("accessEmail") ?? null}
					handle={consent.handle}
					csrfToken={csrfToken}
				/>,
				200,
				consent.headers,
			);
		} catch (error) {
			return handleAuthorizeError(c, error, allowed);
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

		const allowed = allowedRedirectHosts(c.env.OAUTH_ALLOWED_REDIRECT_HOSTS);
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
				if (!isAllowedAuthorizationRequest(denied.request, allowed)) {
					return errorPage(
						c,
						400,
						"このクライアントの redirect_uri は許可されていません。",
					);
				}
				denied.headers.set("Content-Security-Policy", CONSENT_CSP);
				return new Response(null, {
					status: 302,
					headers: denied.headers,
				});
			}

			// 空の scope で承認すると、権限の無い grant を作ってしまう。
			const scopes = form.getAll("scope").map(String).filter(Boolean);
			if (scopes.length === 0) {
				return errorPage(c, 400, "少なくとも 1 つの権限を選んでください。");
			}
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
			if (!isAllowedAuthorizationRequest(approved.request, allowed)) {
				return errorPage(
					c,
					400,
					"このクライアントの redirect_uri は許可されていません。",
				);
			}
			approved.headers.set("Location", redirectTo);
			approved.headers.set("Content-Security-Policy", CONSENT_CSP);
			return new Response(null, {
				status: 302,
				headers: approved.headers,
			});
		} catch (error) {
			return handleAuthorizeError(c, error, allowed);
		}
	});
}
