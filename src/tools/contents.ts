import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props } from "../types";
import { withOctokit } from "./helpers";

function toBase64(text: string): string {
	return btoa(unescape(encodeURIComponent(text)));
}

function fromBase64(b64: string): string {
	return decodeURIComponent(escape(atob(b64)));
}

export function registerContentTools(server: McpServer, env: Env, props: Props): void {
	server.tool(
		"github_get_file_contents",
		"Read a file's contents, or list a directory's entries if the path points to a directory.",
		{
			owner: z.string(),
			repo: z.string(),
			path: z.string().describe("File or directory path relative to repo root. Use '' for repo root."),
			ref: z.string().optional().describe("Branch, tag, or SHA. Defaults to the repo's default branch."),
		},
		async ({ owner, repo, path, ref }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });

				if (Array.isArray(data)) {
					return data.map((entry) => ({
						name: entry.name,
						path: entry.path,
						type: entry.type,
						size: entry.size,
					}));
				}

				if (data.type === "file") {
					return {
						path: data.path,
						sha: data.sha,
						size: data.size,
						content: data.content ? fromBase64(data.content.replace(/\n/g, "")) : "",
					};
				}

				return { path: data.path, type: data.type };
			}),
	);

	server.tool(
		"github_create_or_update_file",
		"Create a new file or update an existing one. If updating, the current file SHA is fetched " +
			"automatically unless provided — pass it explicitly when you already have it to save a round trip " +
			"or to guard against concurrent modification.",
		{
			owner: z.string(),
			repo: z.string(),
			path: z.string(),
			content: z.string().describe("Plain-text file content (will be base64-encoded for the API)."),
			message: z.string().describe("Commit message."),
			branch: z.string().optional().describe("Defaults to the repo's default branch."),
			sha: z.string().optional().describe("Current file blob SHA, required by GitHub when overwriting an existing file."),
		},
		async ({ owner, repo, path, content, message, branch, sha }) =>
			withOctokit(env, props, async (octokit) => {
				let existingSha = sha;
				if (!existingSha) {
					try {
						const { data: existing } = await octokit.rest.repos.getContent({
							owner,
							repo,
							path,
							ref: branch,
						});
						if (!Array.isArray(existing) && existing.type === "file") {
							existingSha = existing.sha;
						}
					} catch {
						// 404 means this is a new file — proceed without a sha.
					}
				}

				const { data } = await octokit.rest.repos.createOrUpdateFileContents({
					owner,
					repo,
					path,
					message,
					content: toBase64(content),
					branch,
					sha: existingSha,
				});
				return {
					path: data.content?.path,
					sha: data.content?.sha,
					commitSha: data.commit.sha,
					htmlUrl: data.content?.html_url,
				};
			}),
	);

	server.tool(
		"github_delete_file",
		"Delete a file from a repository. Irreversible via this tool — confirm with the user before calling.",
		{
			owner: z.string(),
			repo: z.string(),
			path: z.string(),
			message: z.string().describe("Commit message."),
			sha: z.string().describe("Current file blob SHA — fetch via github_get_file_contents first."),
			branch: z.string().optional(),
		},
		async ({ owner, repo, path, message, sha, branch }) =>
			withOctokit(env, props, async (octokit) => {
				const { data } = await octokit.rest.repos.deleteFile({
					owner,
					repo,
					path,
					message,
					sha,
					branch,
				});
				return { commitSha: data.commit.sha };
			}),
	);
}
