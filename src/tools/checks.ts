import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props } from "../types";
import { annotationsFor, withOctokit } from "./helpers";

const MISSING_PERMISSION =
	"The GitHub App lacks the permissions this tool needs: Checks (read) and Commit statuses (read). " +
	"The app owner can grant them at https://github.com/settings/installations.";

export function registerCheckTools(server: McpServer, env: Env, props: Props): void {
	server.tool(
		"github_get_check_runs",
		"CI status for a ref: check runs plus the combined commit status. Use it to see why a pull " +
			"request is not mergeable (mergeable_state 'unstable' or 'blocked' says only that something " +
			"is failing or pending). Requires the GitHub App's Checks (read) and Commit statuses (read) permissions.",
		{
			owner: z.string(),
			repo: z.string(),
			ref: z.string().min(1).describe("Branch, tag, or commit SHA. For a pull request, use its head branch or head SHA."),
			per_page: z.number().int().min(1).max(100).optional(),
			page: z.number().int().min(1).optional(),
		},
		annotationsFor("github_get_check_runs"),
		async ({ owner, repo, ref, per_page, page }) =>
			withOctokit(env, props, async (octokit) => {
				try {
					const [runs, combined] = await Promise.all([
						octokit.rest.checks.listForRef({ owner, repo, ref, per_page, page }),
						octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }),
					]);
					return {
						ref,
						combinedState: combined.data.state,
						totalCheckRuns: runs.data.total_count,
						checkRuns: runs.data.check_runs.map((r) => ({
							name: r.name,
							status: r.status,
							conclusion: r.conclusion,
							startedAt: r.started_at,
							completedAt: r.completed_at,
							app: r.app?.slug,
							htmlUrl: r.html_url,
						})),
						statuses: combined.data.statuses.map((s) => ({
							context: s.context,
							state: s.state,
							description: s.description,
							targetUrl: s.target_url,
						})),
					};
				} catch (error) {
					// GitHub answers a missing App permission with 403 "Resource not accessible by
					// integration" -- accurate but opaque. Say what to grant, keep the status.
					if ((error as { status?: number }).status === 403) {
						throw Object.assign(new Error(MISSING_PERMISSION), { status: 403 });
					}
					throw error;
				}
			}),
	);
}
