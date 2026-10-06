import { describe, expect, it } from "vitest";
import {
	allowedRedirectHosts,
	clientIdMetadataHost,
	DEFAULT_ALLOWED_REDIRECT_HOSTS,
	isAllowedAuthorizationRequest,
	isAllowedRedirectUri,
} from "../../src/oauth/config.js";

describe("oauth config", () => {
	describe("allowedRedirectHosts", () => {
		it("uses the default allowlist when unset or empty", () => {
			expect(allowedRedirectHosts(undefined)).toEqual(
				new Set(DEFAULT_ALLOWED_REDIRECT_HOSTS),
			);
			expect(allowedRedirectHosts("  ,  ")).toEqual(
				new Set(DEFAULT_ALLOWED_REDIRECT_HOSTS),
			);
		});

		it("parses a comma-separated override, trimming and lowercasing", () => {
			expect(allowedRedirectHosts(" Example.com , chatgpt.com ")).toEqual(
				new Set(["example.com", "chatgpt.com"]),
			);
		});
	});

	describe("isAllowedRedirectUri", () => {
		const allowed = allowedRedirectHosts(undefined);

		it("accepts an HTTPS redirect on an allowlisted host", () => {
			expect(
				isAllowedRedirectUri("https://chatgpt.com/connector/callback", allowed),
			).toBe(true);
		});

		it("rejects unknown hosts, malformed URLs and non-http(s) schemes", () => {
			expect(isAllowedRedirectUri("https://evil.example/cb", allowed)).toBe(
				false,
			);
			expect(isAllowedRedirectUri("not a url", allowed)).toBe(false);
			expect(isAllowedRedirectUri("javascript:alert(1)", allowed)).toBe(false);
			expect(isAllowedRedirectUri("ftp://claude.ai/cb", allowed)).toBe(false);
		});
	});

	describe("clientIdMetadataHost", () => {
		it("returns the https host for a CIMD client_id URL", () => {
			expect(clientIdMetadataHost("https://claude.ai/client.json")).toBe(
				"claude.ai",
			);
			expect(clientIdMetadataHost("https://claude.ai:8443/client.json")).toBe(
				"claude.ai",
			);
		});

		it("returns null for a non-URL or non-https client_id", () => {
			expect(clientIdMetadataHost("opaque-client-id")).toBeNull();
			expect(clientIdMetadataHost("http://claude.ai/client.json")).toBeNull();
		});
	});

	describe("isAllowedAuthorizationRequest", () => {
		const allowed = allowedRedirectHosts(undefined);

		it("allows when the redirect host is allowlisted", () => {
			expect(
				isAllowedAuthorizationRequest(
					{
						clientId: "https://registered.example/client",
						redirectUri: "https://chatgpt.com/cb",
					},
					allowed,
				),
			).toBe(true);
		});

		it("allows when only the CIMD client_id host is allowlisted", () => {
			expect(
				isAllowedAuthorizationRequest(
					{
						clientId: "https://claude.ai/client.json",
						redirectUri: "https://unlisted.example/cb",
					},
					allowed,
				),
			).toBe(true);
		});

		it("rejects when neither host is allowlisted", () => {
			expect(
				isAllowedAuthorizationRequest(
					{
						clientId: "https://evil.example/client.json",
						redirectUri: "https://evil.example/cb",
					},
					allowed,
				),
			).toBe(false);
		});
	});
});
