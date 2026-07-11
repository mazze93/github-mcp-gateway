import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props } from "../types";
import { withOctokit } from "./helpers";

export function registerPullRequestTools(server: McpServer, env: Env, props: Props): void {
	server.tool(
		"github_list_pull_requests",
		"List pull requests in a repository.",
		{
			owner: z.string(),
			repo: z.string(),
			state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to 'open'."),
			per_page: z.number().int().min(1).max(100).optional(),
		},
		async ({ owner, repo, state, per_page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.pulls.list({
					owner,
					repo,
					state: state ?? "open",
					per_page: per_page ?? 30,
				});
				return data.map((pr) => ({
					number: pr.number,
					title: pr.title,
					state: pr.state,
					draft: pr.draft,
					author: pr.user?.login,
					base: pr.base.ref,
					head: pr.head.ref,
					updatedAt: pr.updated_at,
					htmlUrl: pr.html_url,
				}));
			}),
	);

	server.tool(
		"github_get_pull_request",
		"Get full details of a pull request, including mergeability and review-required status.",
		{
			owner: z.string(),
			repo: z.string(),
			pull_number: z.number().int(),
		},
		async ({ owner, repo, pull_number }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
				return {
					number: data.number,
					title: data.title,
					body: data.body,
					state: data.state,
					draft: data.draft,
					mergeable: data.mergeable,
					mergeableState: data.mergeable_state,
					base: data.base.ref,
					head: data.head.ref,
					additions: data.additions,
					deletions: data.deletions,
					changedFiles: data.changed_files,
					htmlUrl: data.html_url,
				};
			}),
	);

	server.tool(
		"github_list_pull_request_files",
		"List the files changed in a pull request, with per-file diff stats.",
		{
			owner: z.string(),
			repo: z.string(),
			pull_number: z.number().int(),
		},
		async ({ owner, repo, pull_number }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number });
				return data.map((f) => ({
					filename: f.filename,
					status: f.status,
					additions: f.additions,
					deletions: f.deletions,
					patch: f.patch,
				}));
			}),
	);

	server.tool(
		"github_create_pull_request",
		"Open a new pull request from one branch into another.",
		{
			owner: z.string(),
			repo: z.string(),
			title: z.string(),
			head: z.string().describe("Branch containing the changes, e.g. 'feature/x' or 'fork-owner:branch'."),
			base: z.string().describe("Branch to merge into, e.g. 'main'."),
			body: z.string().optional(),
			draft: z.boolean().optional(),
		},
		async ({ owner, repo, title, head, base, body, draft }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.pulls.create({
					owner,
					repo,
					title,
					head,
					base,
					body,
					draft,
				});
				return { number: data.number, htmlUrl: data.html_url };
			}),
	);

	server.tool(
		"github_merge_pull_request",
		"Merge a pull request. Destructive and irreversible via this tool — confirm with the user before calling.",
		{
			owner: z.string(),
			repo: z.string(),
			pull_number: z.number().int(),
			merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Defaults to 'merge'."),
			commit_title: z.string().optional(),
		},
		async ({ owner, repo, pull_number, merge_method, commit_title }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.pulls.merge({
					owner,
					repo,
					pull_number,
					merge_method: merge_method ?? "merge",
					commit_title,
				});
				return { merged: data.merged, sha: data.sha, message: data.message };
			}),
	);
}
