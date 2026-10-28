import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { explainCheckError, registerCheckTools } from "../src/tools/checks";
import { registerContentTools } from "../src/tools/contents";
import { registerIssueTools } from "../src/tools/issues";
import { registerPullRequestTools } from "../src/tools/pulls";
import { registerRepoTools } from "../src/tools/repos";
import { registerSearchTools } from "../src/tools/search";
import type { Props } from "../src/types";

const props: Props = { login: "tool-surface-user", name: null, email: null, accessToken: "bootstrap-value" };

async function connect(): Promise<Client> {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerRepoTools(server, env, props);
	registerIssueTools(server, env, props);
	registerPullRequestTools(server, env, props);
	registerContentTools(server, env, props);
	registerSearchTools(server, env, props);
	registerCheckTools(server, env, props);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await client.connect(clientSide);
	return client;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("tool surface", () => {
	it("exposes exactly the documented tools, each with annotations", async () => {
		const { tools } = await (await connect()).listTools();
		expect(tools).toHaveLength(24);
		for (const tool of tools) {
			expect(tool.annotations, tool.name).toBeDefined();
			expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
			expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
		}
	});

	it("flags exactly the irreversible/overwriting tools as destructive", async () => {
		const { tools } = await (await connect()).listTools();
		const destructive = tools
			.filter((t) => t.annotations?.destructiveHint)
			.map((t) => t.name)
			.sort();
		expect(destructive).toEqual([
			"github_create_or_update_file",
			"github_delete_file",
			"github_merge_pull_request",
			"github_update_repo",
		]);
	});

	it("never marks a read-only tool destructive, and every get/list/search tool is read-only", async () => {
		const { tools } = await (await connect()).listTools();
		for (const tool of tools) {
			if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
			if (/^github_(get|list|search)_/.test(tool.name)) {
				expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
			}
		}
	});
});

describe("new tools", () => {
	beforeEach(async () => {
		await env.OAUTH_KV.delete(`github:tokens:${props.login}`);
	});
	afterEach(() => vi.unstubAllGlobals());

	function stub(routes: Record<string, () => Response>) {
		const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			// Octokit percent-encodes the slash in refs (heads%2Fmain); GitHub accepts either form.
			const key = `${(init?.method ?? "GET").toUpperCase()} ${decodeURIComponent(url.pathname)}`;
			const route = routes[key];
			if (!route) throw new Error(`unstubbed request: ${key}`);
			return route();
		});
		vi.stubGlobal("fetch", spy);
		return spy;
	}

	it("github_create_branch branches from the default branch's head", async () => {
		const spy = stub({
			"GET /repos/o/r": () => json({ default_branch: "main" }),
			"GET /repos/o/r/git/ref/heads/main": () => json({ object: { sha: "abc123" } }),
			"POST /repos/o/r/git/refs": () => json({ ref: "refs/heads/feature", object: { sha: "abc123" } }, 201),
		});
		const result = await (await connect()).callTool({
			name: "github_create_branch",
			arguments: { owner: "o", repo: "r", branch: "feature" },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({
			branch: "feature",
			ref: "refs/heads/feature",
			sha: "abc123",
			from: "main",
		});
		const create = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
		expect(JSON.parse((create?.[1] as RequestInit).body as string)).toEqual({
			ref: "refs/heads/feature",
			sha: "abc123",
		});
	});

	it("github_list_issue_comments returns the thread with author association", async () => {
		stub({
			"GET /repos/o/r/issues/7/comments": () =>
				json([
					{
						id: 1,
						user: { login: "stranger" },
						author_association: "NONE",
						body: "hi",
						created_at: "t0",
						updated_at: "t1",
						html_url: "u",
					},
				]),
		});
		const result = await (await connect()).callTool({
			name: "github_list_issue_comments",
			arguments: { owner: "o", repo: "r", issue_number: 7 },
		});
		const [first] = JSON.parse((result.content as { text: string }[])[0].text);
		expect(first).toMatchObject({ id: 1, author: "stranger", authorAssociation: "NONE", body: "hi" });
	});

	it("github_get_check_runs merges check runs and combined status", async () => {
		stub({
			"GET /repos/o/r/commits/main/check-runs": () =>
				json({
					total_count: 1,
					check_runs: [
						{
							name: "ci",
							status: "completed",
							conclusion: "failure",
							app: { slug: "github-actions" },
							html_url: "u",
						},
					],
				}),
			"GET /repos/o/r/commits/main/status": () => json({ state: "failure", statuses: [] }),
		});
		const result = await (await connect()).callTool({
			name: "github_get_check_runs",
			arguments: { owner: "o", repo: "r", ref: "main" },
		});
		const body = JSON.parse((result.content as { text: string }[])[0].text);
		expect(body.combinedState).toBe("failure");
		expect(body.checkRuns[0]).toMatchObject({ name: "ci", conclusion: "failure", app: "github-actions" });
	});

	// Not driven through HTTP: Octokit's retry plugin leaks an unhandled rejection
	// for ANY failed request (reproduced on github_get_file_contents too), which
	// Vitest rightly treats as a failure. The mapping itself is what matters here.
	it("explains a missing App permission instead of an opaque 403", () => {
		const forbidden = Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
		const explained = explainCheckError(forbidden) as Error & { status: number };
		expect(explained.status).toBe(403);
		expect(explained.message).toContain("Checks (read)");
		expect(explained.message).toContain("Commit statuses (read)");
	});

	it("passes any other error through unchanged", () => {
		const notFound = Object.assign(new Error("Not Found"), { status: 404 });
		expect(explainCheckError(notFound)).toBe(notFound);
		expect(explainCheckError(undefined)).toBeUndefined();
	});

});
