import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
