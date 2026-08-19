import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props } from "../types";
import { withOctokit } from "./helpers";

export function registerSearchTools(server: McpServer, env: Env, props: Props): void {
	server.tool(
		"github_search_code",
		"Search code across repositories accessible to this token. Use GitHub search qualifiers " +
			"(e.g. 'repo:owner/name', 'path:src', 'language:typescript') in the query.",
		{
			query: z.string().describe("GitHub code search query, e.g. 'useEffect repo:owner/name'."),
			per_page: z.number().int().min(1).max(100).optional(),
		},
		async ({ query, per_page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.search.code({ q: query, per_page: per_page ?? 20 });
				return {
					totalCount: data.total_count,
					items: data.items.map((item) => ({
						repo: item.repository.full_name,
						path: item.path,
						htmlUrl: item.html_url,
					})),
				};
			}),
	);

	server.tool(
		"github_search_issues",
		"Search issues and pull requests across repositories. Use GitHub search qualifiers " +
			"(e.g. 'is:open', 'is:pr', 'author:username', 'repo:owner/name').",
		{
			query: z.string().describe("GitHub search query, e.g. 'is:open is:pr repo:owner/name'."),
			per_page: z.number().int().min(1).max(100).optional(),
		},
		async ({ query, per_page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.search.issuesAndPullRequests({
					q: query,
					per_page: per_page ?? 20,
				});
				return {
					totalCount: data.total_count,
					items: data.items.map((item) => ({
						number: item.number,
						title: item.title,
						state: item.state,
						isPullRequest: Boolean(item.pull_request),
						repoUrl: item.repository_url,
						htmlUrl: item.html_url,
					})),
				};
			}),
	);
}
