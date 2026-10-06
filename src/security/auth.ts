import type { Context, Hono } from "hono";
import { jsx } from "hono/jsx";
import { resolveAccessIdentity } from "../db/users.js";
import { DEFAULT_USER_ID } from "../default-user.js";
import type { AppEnv } from "../env.js";
import { ConsentErrorPage } from "../views/consent.js";
import {
	type AccessAuthError,
	requireAccessUser,
	requireAccessUserForRead,
} from "./access-auth.js";

type FetchFn = typeof fetch;

/**
 * 認証なしで到達できる公開パス。
 *
 * deny-by-default のため、ここに載っていないパスはすべて Cloudflare Access
 * JWT を必須にする。パスは列挙ではなく「公開パス以外は必須」で判定する。
 *
 *   - `/oauth/*`        … OAuth の token / revocation / 登録エンドポイント。
 *   - `/.well-known/*`  … AS metadata / protected resource metadata（RFC 8414 / 9728）。
 *   - `/skills/*`       … 配布用 Skill（静的ファイル）。
 *   - 静的アセット       … CSS / JS / 3D モデル / favicon など。
 *
 * `/mcp` は OAuthProvider が access token 必須で処理するため、このミドルウェアには
 * 到達しない。`/authorize` はここに載せず Access JWT 必須のままにする。
 */
const PUBLIC_PATH_PREFIXES = [
	"/oauth",
	"/.well-known",
	"/skills",
	"/css",
	"/js",
	"/models",
] as const;

const PUBLIC_EXACT_PATHS = new Set(["/favicon.ico", "/robots.txt"]);

/** CSRF（Fetch Metadata）検査を省略してよい安全なメソッド。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 同意画面を出す `/authorize` のパス（正規化後）。 */
const AUTHORIZE_PAGE_PATH = "/authorize";

/** 認証・アカウント状態の失敗を同意画面向けの日本語メッセージへ対応付ける。 */
const ACCESS_ERROR_MESSAGES: Record<AccessAuthError, string> = {
	access_not_configured:
		"サーバーの認証設定が完了していません。管理者に連絡してください。",
	unauthorized:
		"ログインが必要です。Cloudflare Access でログインしてから、コネクタから接続し直してください。",
	csrf_forbidden:
		"リクエストの検証に失敗しました。前の画面に戻ってやり直してください。",
};

/**
 * `/authorize` の認証・アカウント失敗を同意画面の HTML で表示する（それ以外の
 * パスは JSON のまま返すかどうかを呼び出し側で決める）。
 */
function authFailureResponse(
	c: Context<AppEnv>,
	status: number,
	message: string,
): Response {
	return c.html(jsx(ConsentErrorPage, { message }) as never, status as never, {
		"Content-Security-Policy": "frame-ancestors 'none'",
		"Cache-Control": "no-store",
	});
}

/**
 * 公開パス判定用にリクエストパスを正規化する。
 *
 * `c.req.path` は Hono がルーティングに使う値（percent-decode 済み）と同じものを使う。
 * 末尾スラッシュ・大文字小文字・連続スラッシュの表記差で公開判定をすり抜けられない
 * よう、判定の前にここで揃える。大文字小文字は **ASCII のみ** を畳む。`toLowerCase()`
 * は Unicode の単純ケースフォールディングを行い、`U+212A`(KELVIN SIGN) を `k` に
 * 畳むため、将来 `/skills` と大小違いの保護ルートを足したときに公開扱いになり得る。
 * ASCII のみの畳み込みにして、公開側への倒れ込みを ASCII の範囲に限定する。
 */
export function normalizePath(pathname: string): string {
	const collapsed = pathname
		.replace(/[A-Z]/g, (character) => character.toLowerCase())
		.replace(/\/{2,}/g, "/");
	if (collapsed.length > 1 && collapsed.endsWith("/")) {
		return collapsed.slice(0, -1);
	}
	return collapsed;
}

/** 明示した公開パスかどうか。 */
export function isPublicPath(pathname: string): boolean {
	const path = normalizePath(pathname);
	for (const prefix of PUBLIC_PATH_PREFIXES) {
		if (path === prefix || path.startsWith(`${prefix}/`)) return true;
	}
	return PUBLIC_EXACT_PATHS.has(path);
}

/**
 * 認証済みリクエストの内部 `users.id` を返す。
 * 認証ミドルウェアが必ず設定するため、未設定はプログラミングエラーとして扱う。
 */
export function requireUserId(c: Context<AppEnv>): number {
	const userId = c.get("userId");
	if (typeof userId !== "number") {
		throw new Error("Authenticated user is not available");
	}
	return userId;
}

/**
 * deny-by-default の Cloudflare Access 認証ミドルウェアを登録する。
 *
 * 公開パス以外はすべて Access JWT を検証し、subject を内部 `users.id` に解決して
 * `c.set("userId", ...)` する。GET / HEAD / OPTIONS は読み取りとして CSRF 検査を
 * 省略し、それ以外のメソッドは `Sec-Fetch-Site` を含む CSRF 検査を行う（写真 API の
 * `requireAccessUser` と同一実装を共有し、二重実装しない）。
 *
 * `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` が未設定のときは、ローカルの
 * `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` 経路だけ既定ユーザーへフォールバックし、
 * それ以外は 401 `access_not_configured` で fail-closed になる。
 */
export function registerAccessAuth(
	app: Hono<AppEnv>,
	fetchFn: FetchFn = fetch,
): void {
	app.use("*", async (c, next) => {
		if (isPublicPath(c.req.path)) {
			await next();
			return;
		}

		const isSafe = SAFE_METHODS.has(c.req.method.toUpperCase());
		const auth = isSafe
			? await requireAccessUserForRead(c, fetchFn)
			: await requireAccessUser(c, fetchFn);
		if (!auth.ok) {
			if (normalizePath(c.req.path) === AUTHORIZE_PAGE_PATH) {
				return authFailureResponse(
					c,
					auth.response.status,
					ACCESS_ERROR_MESSAGES[auth.error],
				);
			}
			return auth.response;
		}

		// ACCESS_* 未設定かつローカル開発フラグが有効なときだけ user: null になる。
		// 本番ではこの分岐に入らない（authenticateAccessUser が 401 を返す）。
		if (auth.user === null) {
			c.set("userId", DEFAULT_USER_ID);
			c.set("accessSubject", "local-development");
			await next();
			return;
		}

		const isAuthorizePage = normalizePath(c.req.path) === AUTHORIZE_PAGE_PATH;
		const subject = auth.user.sub;
		if (!subject) {
			if (isAuthorizePage) {
				return authFailureResponse(c, 401, ACCESS_ERROR_MESSAGES.unauthorized);
			}
			return c.json({ error: "unauthorized" }, 401);
		}

		const resolution = await resolveAccessIdentity(c.env.DB, {
			subject,
			email: auth.user.email ?? null,
		});
		if (resolution.status === "not_registered") {
			if (isAuthorizePage) {
				return authFailureResponse(
					c,
					403,
					"このアカウントは登録されていません。管理者に連絡してください。",
				);
			}
			return c.json({ error: "user_not_registered" }, 403);
		}
		if (resolution.status === "disabled") {
			if (isAuthorizePage) {
				return authFailureResponse(
					c,
					403,
					"このアカウントは無効化されています。管理者に連絡してください。",
				);
			}
			return c.json({ error: "account_disabled" }, 403);
		}

		c.set("userId", resolution.userId);
		c.set("accessSubject", subject);
		c.set("accessEmail", auth.user.email ?? undefined);
		await next();
	});
}
