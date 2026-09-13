import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackHandler } from "../../../src/mcp/tools/feedback.js";

describe("MCP feedback tool handler", () => {
	describe("createFeedbackHandler", () => {
		it("should return isError: true and pre-filled manual URL when GITHUB_TOKEN is not set", async () => {
			const mockFetch = vi.fn();
			const result = await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: undefined },
				{
					title: "新しい測定単位の追加要望",
					body: "心拍数の推移を記録したいです",
				},
				mockFetch,
			);

			expect(mockFetch).not.toHaveBeenCalled();
			expect(result.isError).toBe(true);
			if (!result.isError) throw new Error("Expected isError: true");

			expect(result.manual_url).toBeDefined();
			expect(result.manual_url).toContain(
				"https://github.com/japan4415/training-logger/issues/new?",
			);
			expect(result.manual_url).toContain(
				`title=${encodeURIComponent("新しい測定単位の追加要望")}`,
			);
			expect(result.manual_url).toContain(
				`body=${encodeURIComponent("心拍数の推移を記録したいです")}`,
			);
			expect(result.manual_url).toContain("labels=enhancement,from-mcp");
			expect(result.error).toContain("GITHUB_TOKEN が未設定");
		});

		it("should use custom GITHUB_REPO_OWNER and GITHUB_REPO_NAME for manual URL when token not set", async () => {
			const mockFetch = vi.fn();
			const result = await createFeedbackHandler(
				{
					...env,
					GITHUB_TOKEN: undefined,
					GITHUB_REPO_OWNER: "custom-owner",
					GITHUB_REPO_NAME: "custom-repo",
				},
				{
					title: "カスタムリポジトリへの要望",
					body: "テスト本文",
				},
				mockFetch,
			);

			expect(mockFetch).not.toHaveBeenCalled();
			expect(result.isError).toBe(true);
			if (!result.isError) throw new Error("Expected isError: true");

			expect(result.manual_url).toContain(
				"https://github.com/custom-owner/custom-repo/issues/new?",
			);
		});

		it("should return duplicate: true and existing issue info without calling POST when open issue with identical trimmed title exists", async () => {
			const mockFetch = vi.fn();
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							number: 42,
							title: "ダンベルフライの追加要望",
							html_url:
								"https://github.com/japan4415/training-logger/issues/42",
						},
						{
							number: 43,
							title: "別の issue",
							html_url:
								"https://github.com/japan4415/training-logger/issues/43",
						},
					]),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const result = await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: "mock-pat-token" },
				{
					title: "  ダンベルフライの追加要望  ",
					body: "ダンベルフライを追加してほしいです",
					category: "exercise_request",
				},
				mockFetch,
			);

			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/japan4415/training-logger/issues?state=open&per_page=100",
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Accept: "application/vnd.github+json",
						Authorization: "Bearer mock-pat-token",
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": "training-logger-mcp",
					}),
				}),
			);

			expect(result.duplicate).toBe(true);
			if (!result.duplicate) throw new Error("Expected duplicate: true");
			expect(result.issue_number).toBe(42);
			expect(result.html_url).toBe(
				"https://github.com/japan4415/training-logger/issues/42",
			);
			expect(result.title).toBe("ダンベルフライの追加要望");
		});

		it("should create issue on 201 response and verify headers, body, labels, and footer", async () => {
			const mockFetch = vi.fn();
			// 1. GET open issues returns empty
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			// 2. POST creates issue
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						number: 56,
						html_url: "https://github.com/japan4415/training-logger/issues/56",
						title: "RPE による負荷設定の要望",
						state: "open",
					}),
					{
						status: 201,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const result = await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: "mock-pat-token" },
				{
					title: "RPE による負荷設定の要望",
					body: "RPE（主観的運動強度）を記録できるようにしてほしいです",
					category: "feature",
				},
				mockFetch,
			);

			expect(mockFetch).toHaveBeenCalledTimes(2);

			// Check POST call
			const [postUrl, postOptions] = mockFetch.mock.calls[1];
			expect(postUrl).toBe(
				"https://api.github.com/repos/japan4415/training-logger/issues",
			);
			expect(postOptions.method).toBe("POST");
			expect(postOptions.headers).toEqual({
				Accept: "application/vnd.github+json",
				Authorization: "Bearer mock-pat-token",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "training-logger-mcp",
				"Content-Type": "application/json",
			});

			const parsedBody = JSON.parse(postOptions.body as string);
			expect(parsedBody.title).toBe("RPE による負荷設定の要望");
			expect(parsedBody.labels).toEqual(["enhancement", "from-mcp"]);
			expect(parsedBody.body).toContain(
				"RPE（主観的運動強度）を記録できるようにしてほしいです",
			);
			expect(parsedBody.body).toContain(
				"---\n起票元: training-logger MCP create_feedback (category: feature)",
			);

			// Result verification
			expect(result.duplicate).toBeUndefined();
			expect(result.isError).toBeUndefined();
			if (result.duplicate || result.isError)
				throw new Error("Expected successful result");
			expect(result.issue_number).toBe(56);
			expect(result.html_url).toBe(
				"https://github.com/japan4415/training-logger/issues/56",
			);
			expect(result.title).toBe("RPE による負荷設定の要望");
			expect(result.state).toBe("open");
		});

		it("should default category to feature when not specified", async () => {
			const mockFetch = vi.fn();
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify([]), { status: 200 }),
			);
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						number: 57,
						html_url: "https://github.com/japan4415/training-logger/issues/57",
						title: "既定カテゴリテスト",
						state: "open",
					}),
					{ status: 201 },
				),
			);

			await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: "mock-pat-token" },
				{
					title: "既定カテゴリテスト",
					body: "本文",
				},
				mockFetch,
			);

			const parsedBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
			expect(parsedBody.body).toContain("(category: feature)");
		});

		it("should return isError: true with status and message on 401 Unauthorized", async () => {
			const mockFetch = vi.fn();
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						message: "Bad credentials",
						documentation_url: "https://docs.github.com/rest",
					}),
					{
						status: 401,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const result = await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: "invalid-token" },
				{
					title: "401 テスト",
					body: "本文",
				},
				mockFetch,
			);

			expect(result.isError).toBe(true);
			if (!result.isError) throw new Error("Expected isError: true");
			expect(result.status).toBe(401);
			expect(result.message).toContain("Bad credentials");
			expect(result.error).toContain("401");
			expect(result.error).toContain("Bad credentials");
		});

		it("should return isError: true with status and message on 422 Unprocessable Entity", async () => {
			const mockFetch = vi.fn();
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify([]), { status: 200 }),
			);
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						message: "Validation Failed",
						errors: [
							{ resource: "Issue", field: "title", code: "missing_field" },
						],
					}),
					{
						status: 422,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const result = await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: "mock-pat-token" },
				{
					title: "422 テスト",
					body: "本文",
				},
				mockFetch,
			);

			expect(result.isError).toBe(true);
			if (!result.isError) throw new Error("Expected isError: true");
			expect(result.status).toBe(422);
			expect(result.message).toContain("Validation Failed");
			expect(result.error).toContain("422");
			expect(result.error).toContain("Validation Failed");
		});

		it("should return isError: true when network error occurs", async () => {
			const mockFetch = vi.fn();
			mockFetch.mockRejectedValueOnce(new Error("Network connection error"));

			const result = await createFeedbackHandler(
				{ ...env, GITHUB_TOKEN: "mock-pat-token" },
				{
					title: "エラーテスト",
					body: "本文",
				},
				mockFetch,
			);

			expect(result.isError).toBe(true);
			if (!result.isError) throw new Error("Expected isError: true");
			expect(result.error).toContain("Network connection error");
		});
	});
});
