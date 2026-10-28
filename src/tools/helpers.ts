import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Octokit } from "octokit";
import { getOctokit, ReauthorizationRequiredError } from "../github-client";
import type { Props } from "../types";

export type ToolResult = CallToolResult;

export function ok(value: unknown): ToolResult {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps every tool handler: resolves a fresh Octokit client, runs the call,
 * and converts both our own re-auth signal and arbitrary Octokit
 * RequestErrors into a single predictable shape the calling agent can act
 * on (rather than an unhandled throw reaching the MCP transport).
 */
export async function withOctokit(
	env: Env,
	props: Props,
	fn: (octokit: Octokit) => Promise<unknown>,
): Promise<ToolResult> {
	try {
		const octokit = await getOctokit(env, props);
		return ok(await fn(octokit));
	} catch (error) {
		if (error instanceof ReauthorizationRequiredError) {
			return fail(error.message);
		}
		const status = (error as { status?: number } | undefined)?.status;
		const message = error instanceof Error ? error.message : String(error);
		return fail(status ? `GitHub API error (${status}): ${message}` : `GitHub API error: ${message}`);
	}
}

// MCP clients use these hints to decide what needs a confirmation prompt. The
// descriptions of the destructive tools say "confirm with the user", but prose
// is only advice to the model; annotations are what a client can enforce.
// openWorldHint is true throughout: every tool talks to GitHub.
const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const IDEMPOTENT_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const ANNOTATIONS: Record<string, ToolAnnotations> = {
	github_list_repos: READ,
	github_get_repo: READ,
	github_list_branches: READ,
	github_list_commits: READ,
	github_get_commit: READ,
	github_update_repo: DESTRUCTIVE,
	github_create_branch: ADD,
	github_list_issues: READ,
	github_get_issue: READ,
	github_list_issue_comments: READ,
	github_create_issue: ADD,
	github_comment_on_issue: ADD,
	github_close_issue: IDEMPOTENT_WRITE,
	github_list_pull_requests: READ,
	github_get_pull_request: READ,
	github_list_pull_request_files: READ,
	github_get_check_runs: READ,
	github_create_pull_request: ADD,
	github_merge_pull_request: DESTRUCTIVE,
	github_get_file_contents: READ,
	// Overwrites an existing file when one is there, so it is not merely additive.
	github_create_or_update_file: DESTRUCTIVE,
	github_delete_file: DESTRUCTIVE,
	github_search_code: READ,
	github_search_issues: READ,
};

/** Throws for an unclassified tool, so a new tool cannot ship without a safety class. */
export function annotationsFor(name: string): ToolAnnotations {
	const annotations = ANNOTATIONS[name];
	if (!annotations) throw new Error(`No MCP annotations declared for tool "${name}"`);
	return annotations;
}
