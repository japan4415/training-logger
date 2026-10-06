import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	AUTHORIZATION_SERVER_SCOPES,
	MCP_RESOURCE,
	OAUTH_ISSUER,
	RESOURCE_REQUIRED_SCOPES,
} from "../../src/oauth/config.js";

const PRM_URL = `${OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp`;
const AS_METADATA_URL = `${OAUTH_ISSUER}/.well-known/oauth-authorization-server`;

describe("OAuth discovery endpoints", () => {
	it("publishes authorization server metadata with the full scope catalogue", async () => {
		const response = await SELF.fetch(AS_METADATA_URL);
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as {
			issuer: string;
			authorization_endpoint: string;
			token_endpoint: string;
			revocation_endpoint?: string;
			scopes_supported?: string[];
			client_id_metadata_document_supported?: boolean;
			registration_endpoint?: string;
		};
		expect(metadata.issuer).toBe(OAUTH_ISSUER);
		expect(metadata.authorization_endpoint).toBe(`${OAUTH_ISSUER}/authorize`);
		expect(metadata.token_endpoint).toBe(`${OAUTH_ISSUER}/oauth/token`);
		expect(metadata.scopes_supported).toEqual(
			expect.arrayContaining([...AUTHORIZATION_SERVER_SCOPES]),
		);
		// CIMD は compat flag（global_fetch_strictly_public）とオプションの両方が必要。
		expect(metadata.client_id_metadata_document_supported).toBe(true);
		// DCR は既定で無効なので registration_endpoint を広告しない。
		expect(metadata.registration_endpoint).toBeUndefined();
	});

	it("publishes protected resource metadata with only the baseline scopes", async () => {
		const response = await SELF.fetch(PRM_URL);
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as {
			resource: string;
			authorization_servers: string[];
			scopes_supported?: string[];
			bearer_methods_supported?: string[];
		};
		expect(metadata.resource).toBe(MCP_RESOURCE);
		expect(metadata.authorization_servers).toEqual([OAUTH_ISSUER]);
		expect(metadata.scopes_supported).toEqual([...RESOURCE_REQUIRED_SCOPES]);
		// offline_access は PRM に載せない（MCP 仕様の SHOULD NOT）。
		expect(metadata.scopes_supported).not.toContain("offline_access");
		expect(metadata.bearer_methods_supported).toEqual(["header"]);
	});

	it("returns 401 with a resource_metadata challenge for unauthenticated /mcp", async () => {
		const response = await SELF.fetch(`${MCP_RESOURCE}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			}),
		});
		expect(response.status).toBe(401);
		const challenge = response.headers.get("WWW-Authenticate") ?? "";
		expect(challenge).toContain("Bearer");
		expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
		expect(challenge).toContain('scope="mcp:read"');
		expect(challenge).not.toContain("offline_access");
	});

	it("does not expose /oauth/register while DCR is disabled", async () => {
		const response = await SELF.fetch(`${OAUTH_ISSUER}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/cb"] }),
		});
		expect(response.status).toBe(404);
	});
});
