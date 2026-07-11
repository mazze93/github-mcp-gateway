import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props } from "../types";
import { withOctokit } from "./helpers";

export function registerRepoTools(server: McpServer, env: Env, props: Props): void {
	server.tool(
		"github_list_repos",
		"List repositories this GitHub App installation can access for the authenticated user. " +
			"Use this first if you don't already know the exact owner/repo.",
		{
			per_page: z.number().int().min(1).max(100).optional().describe("Results per page (default 30, max 100)."),
			page: z.number().int().min(1).optional().describe("Page number (default 1)."),
		},
		async ({ per_page, page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data: installations } = await octokit.rest.apps.listInstallationsForAuthenticatedUser();
				const repos: Array<{ owner: string; repo: string; private: boolean; defaultBranch: string }> = [];
				for (const installation of installations.installations) {
					const { data } = await octokit.rest.apps.listInstallationReposForAuthenticatedUser({
						installation_id: installation.id,
						per_page: per_page ?? 30,
						page,
					});
					for (const r of data.repositories) {
						repos.push({
							owner: r.owner.login,
							repo: r.name,
							private: r.private,
							defaultBranch: r.default_branch ?? "main",
						});
					}
				}
				return repos;
			}),
	);

	server.tool(
		"github_get_repo",
		"Get metadata for a single repository (description, default branch, visibility, topics, etc).",
		{
			owner: z.string().describe("Repository owner (user or org)."),
			repo: z.string().describe("Repository name."),
		},
		async ({ owner, repo }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.repos.get({ owner, repo });
				return {
					fullName: data.full_name,
					description: data.description,
					defaultBranch: data.default_branch,
					private: data.private,
					archived: data.archived,
					topics: data.topics,
					openIssuesCount: data.open_issues_count,
					updatedAt: data.updated_at,
					htmlUrl: data.html_url,
				};
			}),
	);

	server.tool(
		"github_list_branches",
		"List branches in a repository.",
		{
			owner: z.string(),
			repo: z.string(),
			per_page: z.number().int().min(1).max(100).optional(),
			page: z.number().int().min(1).optional(),
		},
		async ({ owner, repo, per_page, page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.repos.listBranches({
					owner,
					repo,
					per_page: per_page ?? 30,
					page,
				});
				return data.map((b) => ({ name: b.name, protected: b.protected }));
			}),
	);

	server.tool(
		"github_list_commits",
		"List commits on a branch (or the default branch if none given), optionally filtered to a path.",
		{
			owner: z.string(),
			repo: z.string(),
			branch: z.string().optional().describe("Branch, tag, or SHA. Defaults to the repo's default branch."),
			path: z.string().optional().describe("Only commits touching this file/directory path."),
			per_page: z.number().int().min(1).max(100).optional(),
			page: z.number().int().min(1).optional(),
		},
		async ({ owner, repo, branch, path, per_page, page }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.repos.listCommits({
					owner,
					repo,
					sha: branch,
					path,
					per_page: per_page ?? 20,
					page,
				});
				return data.map((c) => ({
					sha: c.sha,
					message: c.commit.message.split("\n")[0],
					author: c.commit.author?.name,
					date: c.commit.author?.date,
					htmlUrl: c.html_url,
				}));
			}),
	);

	server.tool(
		"github_get_commit",
		"Get full details of a single commit, including changed files and their patches.",
		{
			owner: z.string(),
			repo: z.string(),
			ref: z.string().describe("Commit SHA."),
		},
		async ({ owner, repo, ref }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref });
				return {
					sha: data.sha,
					message: data.commit.message,
					author: data.commit.author,
					stats: data.stats,
					files: data.files?.map((f) => ({
						filename: f.filename,
						status: f.status,
						additions: f.additions,
						deletions: f.deletions,
						patch: f.patch,
					})),
				};
			}),
	);

	server.tool(
		"github_update_repo",
		"Update repository metadata: description, homepage URL, and/or topics. " +
			"Requires the GitHub App to have the Administration repository permission — " +
			"if it doesn't, this returns a 403 and the change must be made another way.",
		{
			owner: z.string(),
			repo: z.string(),
			description: z.string().optional().describe("New repository description."),
			homepage: z.string().optional().describe("New homepage URL."),
			topics: z
				.array(z.string())
				.optional()
				.describe("Replaces ALL existing topics. Lowercase, hyphens, max 50 chars each."),
		},
		async ({ owner, repo, description, homepage, topics }) =>
			withOctokit(env, props, async (octokit) => {
				const result: Record<string, unknown> = {};
				if (description !== undefined || homepage !== undefined) {
					const { data } = await octokit.rest.repos.update({ owner, repo, description, homepage });
					result.description = data.description;
					result.homepage = data.homepage;
				}
				if (topics !== undefined) {
					const { data } = await octokit.rest.repos.replaceAllTopics({ owner, repo, names: topics });
					result.topics = data.names;
				}
				return result;
			}),
	);
}
