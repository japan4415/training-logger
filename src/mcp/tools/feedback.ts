import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bindings } from "../../env.js";

// ---- Types ----

export type FeedbackCategory = "feature" | "bug" | "exercise_request" | "other";

export interface CreateFeedbackParams {
	title: string;
	body: string;
	category?: FeedbackCategory;
}

export type CreateFeedbackResult =
	| {
			issue_number: number;
			html_url: string;
			title: string;
			state: string;
			duplicate?: false;
			isError?: false;
	  }
	| {
			duplicate: true;
			issue_number: number;
			html_url: string;
			title: string;
			isError?: false;
	  }
	| {
			isError: true;
			error: string;
			status?: number;
			message?: string;
			manual_url?: string;
			url?: string;
	  };

// ---- Handler ----

const DEFAULT_REPO_OWNER = "japan4415";
const DEFAULT_REPO_NAME = "training-logger";

export async function createFeedbackHandler(
	env: Bindings,
	params: CreateFeedbackParams,
	fetchFn: typeof fetch = fetch,
): Promise<CreateFeedbackResult> {
	const owner = env.GITHUB_REPO_OWNER || DEFAULT_REPO_OWNER;
	const repo = env.GITHUB_REPO_NAME || DEFAULT_REPO_NAME;

	if (!env.GITHUB_TOKEN) {
		const encodedTitle = encodeURIComponent(params.title);
		const encodedBody = encodeURIComponent(params.body);
		const manualUrl = `https://github.com/${owner}/${repo}/issues/new?title=${encodedTitle}&body=${encodedBody}&labels=enhancement,from-mcp`;

		return {
			isError: true,
			error: `GITHUB_TOKEN が未設定です。以下の URL から手動で issue を起票してください: ${manualUrl}`,
			message: "GITHUB_TOKEN が未設定です",
			manual_url: manualUrl,
			url: manualUrl,
		};
	}

	const trimmedTitle = params.title.trim();
	const commonHeaders: Record<string, string> = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${env.GITHUB_TOKEN}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "training-logger-mcp",
	};

	try {
		// 1. Check open issues for duplicate title
		const listUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100`;
		const listRes = await fetchFn(listUrl, {
			method: "GET",
			headers: commonHeaders,
		});

		if (!listRes.ok) {
			let githubMessage = "";
			try {
				const errJson = (await listRes.json()) as { message?: string };
				githubMessage = errJson.message || listRes.statusText;
			} catch {
				githubMessage = await listRes.text().catch(() => listRes.statusText);
			}
			return {
				isError: true,
				status: listRes.status,
				message: githubMessage,
				error: `GitHub API エラー (${listRes.status}): ${githubMessage}`,
			};
		}

		const openIssues = (await listRes.json()) as Array<{
			number: number;
			html_url: string;
			title: string;
		}>;

		const duplicate = openIssues.find(
			(issue) => issue.title.trim() === trimmedTitle,
		);
		if (duplicate) {
			return {
				duplicate: true,
				issue_number: duplicate.number,
				html_url: duplicate.html_url,
				title: duplicate.title,
			};
		}

		// 2. Create new issue via POST
		const category = params.category ?? "feature";
		const footer = `---\n起票元: training-logger MCP create_feedback (category: ${category})`;
		const postBody = params.body.endsWith("\n")
			? `${params.body}\n${footer}`
			: `${params.body}\n\n${footer}`;

		const postUrl = `https://api.github.com/repos/${owner}/${repo}/issues`;
		const postRes = await fetchFn(postUrl, {
			method: "POST",
			headers: {
				...commonHeaders,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title: params.title,
				body: postBody,
				labels: ["enhancement", "from-mcp"],
			}),
		});

		if (postRes.status === 201) {
			const data = (await postRes.json()) as {
				number: number;
				html_url: string;
				title: string;
				state: string;
			};
			return {
				issue_number: data.number,
				html_url: data.html_url,
				title: data.title,
				state: data.state,
			};
		}

		let githubMessage = "";
		try {
			const errJson = (await postRes.json()) as { message?: string };
			githubMessage = errJson.message || postRes.statusText;
		} catch {
			githubMessage = await postRes.text().catch(() => postRes.statusText);
		}
		return {
			isError: true,
			status: postRes.status,
			message: githubMessage,
			error: `GitHub API エラー (${postRes.status}): ${githubMessage}`,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			isError: true,
			error: `GitHub API 通信エラー: ${msg}`,
			message: msg,
		};
	}
}

// ---- MCP Tool Registration ----

export function registerFeedbackTools(server: McpServer, env: Bindings): void {
	server.registerTool(
		"create_feedback",
		{
			description:
				"training-logger への機能要望・不具合報告・種目追加要望を GitHub issue として起票します。ツールのスキーマで表現できない単位や項目に遭遇したとき、ユーザーの同意を得てから使ってください。",
			inputSchema: {
				title: z
					.string()
					.min(1)
					.max(200)
					.describe("Issue のタイトル（1〜200文字）"),
				body: z
					.string()
					.min(1)
					.describe("Issue の本文（要望・不具合・種目追加の詳細）"),
				category: z
					.enum(["feature", "bug", "exercise_request", "other"])
					.default("feature")
					.describe("フィードバックのカテゴリ（既定: feature）"),
			},
		},
		async (args) => {
			try {
				const result = await createFeedbackHandler(env, args);
				if (result.isError) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(result),
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
