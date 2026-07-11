import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props } from "../types";
import { withOctokit } from "./helpers";

export function registerIssueTools(server: McpServer, env: Env, props: Props): void {
	server.tool(
		"github_list_issues",
		"List issues in a repository. Excludes pull requests by default (GitHub's API treats PRs as issues internally).",
		{
			owner: z.string(),
			repo: z.string(),
			state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to 'open'."),
			labels: z.string().optional().describe("Comma-separated label names to filter by."),
			per_page: z.number().int().min(1).max(100).optional(),
		},
		async ({ owner, repo, state, labels, per_page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.issues.listForRepo({
					owner,
					repo,
					state: state ?? "open",
					labels,
					per_page: per_page ?? 30,
				});
				return data
					.filter((issue) => !issue.pull_request)
					.map((issue) => ({
						number: issue.number,
						title: issue.title,
						state: issue.state,
						labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
						author: issue.user?.login,
						updatedAt: issue.updated_at,
						htmlUrl: issue.html_url,
					}));
			}),
	);

	server.tool(
		"github_get_issue",
		"Get full details of a single issue, including its body text.",
		{
			owner: z.string(),
			repo: z.string(),
			issue_number: z.number().int(),
		},
		async ({ owner, repo, issue_number }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.issues.get({ owner, repo, issue_number });
				return {
					number: data.number,
					title: data.title,
					body: data.body,
					state: data.state,
					labels: data.labels.map((l) => (typeof l === "string" ? l : l.name)),
					assignees: data.assignees?.map((a) => a.login),
					author: data.user?.login,
					htmlUrl: data.html_url,
				};
			}),
	);

	server.tool(
		"github_create_issue",
		"Create a new issue in a repository.",
		{
			owner: z.string(),
			repo: z.string(),
			title: z.string(),
			body: z.string().optional(),
			labels: z.array(z.string()).optional(),
			assignees: z.array(z.string()).optional(),
		},
		async ({ owner, repo, title, body, labels, assignees }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.issues.create({
					owner,
					repo,
					title,
					body,
					labels,
					assignees,
				});
				return { number: data.number, htmlUrl: data.html_url };
			}),
	);

	server.tool(
		"github_comment_on_issue",
		"Add a comment to an issue or pull request (PRs are issues for commenting purposes).",
		{
			owner: z.string(),
			repo: z.string(),
			issue_number: z.number().int(),
			body: z.string(),
		},
		async ({ owner, repo, issue_number, body }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.issues.createComment({
					owner,
					repo,
					issue_number,
					body,
				});
				return { commentId: data.id, htmlUrl: data.html_url };
			}),
	);

	server.tool(
		"github_close_issue",
		"Close an issue, optionally as 'completed' or 'not_planned'.",
		{
			owner: z.string(),
			repo: z.string(),
			issue_number: z.number().int(),
			reason: z.enum(["completed", "not_planned"]).optional(),
		},
		async ({ owner, repo, issue_number, reason }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.issues.update({
					owner,
					repo,
					issue_number,
					state: "closed",
					state_reason: reason,
				});
				return { number: data.number, state: data.state };
			}),
	);
}
