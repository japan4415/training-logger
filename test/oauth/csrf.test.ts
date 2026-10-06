import { describe, expect, it } from "vitest";
import {
	consentCsrfSecret,
	createConsentCsrfToken,
	isLocalDevConsentFallback,
	timingSafeEqual,
	verifyConsentCsrfToken,
} from "../../src/oauth/csrf.js";

const PROD_URL = "https://training-logger.discord.jp/authorize";
const LOCAL_URL = "http://localhost/authorize";

describe("consent CSRF", () => {
	describe("consentCsrfSecret", () => {
		it("uses OAUTH_CONSENT_SECRET when configured", () => {
			expect(
				consentCsrfSecret(
					{ OAUTH_CONSENT_SECRET: "a".repeat(64), ACCESS_AUD: "aud" },
					PROD_URL,
				),
			).toBe("a".repeat(64));
		});

		it("fails closed (null) on a production host without OAUTH_CONSENT_SECRET", () => {
			expect(
				consentCsrfSecret(
					{
						ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
						ACCESS_AUD: "aud",
					},
					PROD_URL,
				),
			).toBeNull();
			// ACCESS_AUD だけでは鍵にならない（JWT で誰でも読めるため）。
			expect(consentCsrfSecret({ ACCESS_AUD: "aud" }, PROD_URL)).toBeNull();
		});

		it("allows a fixed dummy secret only for the local development fallback", () => {
			const env = {
				PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
			};
			expect(isLocalDevConsentFallback(env, LOCAL_URL)).toBe(true);
			expect(consentCsrfSecret(env, LOCAL_URL)).not.toBeNull();
		});

		it("does not fall back when Access is configured or the host is not loopback", () => {
			expect(
				isLocalDevConsentFallback(
					{
						ACCESS_AUD: "aud",
						PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1",
					},
					LOCAL_URL,
				),
			).toBe(false);
			expect(
				isLocalDevConsentFallback(
					{ PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1" },
					PROD_URL,
				),
			).toBe(false);
			expect(
				consentCsrfSecret(
					{ PHOTO_UPLOAD_ALLOW_UNAUTHENTICATED: "1" },
					PROD_URL,
				),
			).toBeNull();
		});
	});

	describe("tokens", () => {
		const secret = "test-secret".padEnd(32, "x");

		it("is deterministic for the same subject and handle", async () => {
			const first = await createConsentCsrfToken(
				"subject-1",
				"handle-1",
				secret,
			);
			const second = await createConsentCsrfToken(
				"subject-1",
				"handle-1",
				secret,
			);
			expect(first).toBe(second);
			expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("changes with the subject or the handle", async () => {
			const base = await createConsentCsrfToken(
				"subject-1",
				"handle-1",
				secret,
			);
			expect(
				await createConsentCsrfToken("subject-2", "handle-1", secret),
			).not.toBe(base);
			expect(
				await createConsentCsrfToken("subject-1", "handle-2", secret),
			).not.toBe(base);
		});

		it("verifies only a token bound to the same subject and handle", async () => {
			const token = await createConsentCsrfToken(
				"subject-1",
				"handle-1",
				secret,
			);
			expect(
				await verifyConsentCsrfToken("subject-1", "handle-1", secret, token),
			).toBe(true);
			expect(
				await verifyConsentCsrfToken("subject-2", "handle-1", secret, token),
			).toBe(false);
			expect(
				await verifyConsentCsrfToken("subject-1", "handle-2", secret, token),
			).toBe(false);
			expect(
				await verifyConsentCsrfToken("subject-1", "handle-1", secret, ""),
			).toBe(false);
		});

		it("compares strings in constant time without throwing on length mismatch", () => {
			expect(timingSafeEqual("abc", "abc")).toBe(true);
			expect(timingSafeEqual("abc", "abd")).toBe(false);
			expect(timingSafeEqual("abc", "abcd")).toBe(false);
		});
	});
});
