import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { revokeAllGrantsForUser } from "../../src/oauth/revocation.js";

function helpersWithPages(
	pages: Array<{ items: { id: string }[]; cursor?: string }>,
): OAuthHelpers {
	let index = 0;
	return {
		listUserGrants: vi.fn(async () => pages[index++] ?? { items: [] }),
		revokeGrant: vi.fn(async () => {}),
	} as unknown as OAuthHelpers;
}

describe("revokeAllGrantsForUser", () => {
	it("revokes every grant across pages and returns the count", async () => {
		const oauth = helpersWithPages([
			{ items: [{ id: "g1" }, { id: "g2" }], cursor: "next" },
			{ items: [{ id: "g3" }] },
		]);
		const revoked = await revokeAllGrantsForUser(oauth, "7");
		expect(revoked).toBe(3);
		expect(oauth.revokeGrant).toHaveBeenCalledWith("g1", "7");
		expect(oauth.revokeGrant).toHaveBeenCalledWith("g2", "7");
		expect(oauth.revokeGrant).toHaveBeenCalledWith("g3", "7");
	});

	it("returns 0 when the user has no grants", async () => {
		const oauth = helpersWithPages([{ items: [] }]);
		expect(await revokeAllGrantsForUser(oauth, "7")).toBe(0);
		expect(oauth.revokeGrant).not.toHaveBeenCalled();
	});
});
