/**
 * 同意画面の CSRF トークン。
 *
 * 承認 POST は、GET で発行した consent handle と検証済み Access `sub` の組に
 * HMAC-SHA256 で束縛したトークンを要求する。ライブラリの consent handle 自体が
 * ブラウザ束縛・単回使用だが、トークンを `sub` にも束縛することで、同じブラウザの
 * 別アカウントが handle を使い回す経路を塞ぐ。`Sec-Fetch-Site` 検査は
 * 認証ミドルウェア（`requireAccessUser`）が別途行う。
 */

import type { Bindings } from "../env.js";

const encoder = new TextEncoder();

/**
 * 開発フォールバック専用のダミー鍵。ACCESS_* 未設定かつ localhost での
 * `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` のときだけ使う。本番ホストでは
 * この鍵は選ばれない（`consentCsrfSecret` が null を返し fail-closed になる）。
 */
const LOCAL_DEV_CONSENT_SECRET = "training-logger-local-dev-consent-secret";

function toBase64Url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/=+$/, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/**
 * Phase 3 の開発フォールバックと同じ条件か。
 * ACCESS_* 未設定 + `PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED=1` + loopback ホスト。
 */
export function isLocalDevConsentFallback(
	env: Pick<
		Bindings,
		"ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED"
	>,
	requestUrl: string,
): boolean {
	if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD) return false;
	if (env.PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED !== "1") return false;
	const hostname = new URL(requestUrl).hostname.toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * CSRF トークンに使う HMAC 鍵を返す。
 *
 * `OAUTH_CONSENT_SECRET` は十分長いランダム値を wrangler secret で投入する前提で、
 * これが唯一の本番用の鍵。未設定かつ開発フォールバックでない場合は `null` を返し、
 * 呼び出し側は同意フローを fail-closed にする（Access の `AUD` は JWT ペイロードに
 * 載る公開値なので、鍵の導出元には使わない）。
 */
export function consentCsrfSecret(
	env: Pick<
		Bindings,
		| "OAUTH_CONSENT_SECRET"
		| "ACCESS_TEAM_DOMAIN"
		| "ACCESS_AUD"
		| "PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED"
	>,
	requestUrl: string,
): string | null {
	if (env.OAUTH_CONSENT_SECRET) return env.OAUTH_CONSENT_SECRET;
	if (isLocalDevConsentFallback(env, requestUrl)) {
		return LOCAL_DEV_CONSENT_SECRET;
	}
	return null;
}

/** `subject` と consent `handle` に束縛した CSRF トークンを作る。 */
export async function createConsentCsrfToken(
	subject: string,
	handle: string,
	secret: string,
): Promise<string> {
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${subject}\u0000${handle}`),
	);
	return toBase64Url(signature);
}

/** 長さ一定時間での文字列比較（タイミング差で一致を漏らさない）。 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return difference === 0;
}

/** 提示された CSRF トークンが `subject` / `handle` に対して正しいか。 */
export async function verifyConsentCsrfToken(
	subject: string,
	handle: string,
	secret: string,
	token: string,
): Promise<boolean> {
	const expected = await createConsentCsrfToken(subject, handle, secret);
	return timingSafeEqual(token, expected);
}
