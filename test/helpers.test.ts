import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ReauthorizationRequiredError } from "../src/github-client";
import { fail, ok, withOctokit } from "../src/tools/helpers";
import type { Props } from "../src/types";

const props: Props = {
	login: "test-user",
	name: "Test User",
	email: null,
	accessToken: "bootstrap-token",
};

describe("ok", () => {
	it("stringifies a plain object", () => {
		const result = ok({ a: 1, b: "two" });
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ a: 1, b: "two" }, null, 2) }]);
	});

	it("passes a string through unstringified", () => {
		const result = ok("already text");
		expect(result.content).toEqual([{ type: "text", text: "already text" }]);
	});
});

describe("fail", () => {
	it("sets isError and wraps the message as content", () => {
		const result = fail("something broke");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "something broke" }]);
	});
});

describe("withOctokit", () => {
	beforeEach(async () => {
		// getFreshAccessToken() falls back to props.accessToken when KV has no
		// stored token for this login -- keep every test on that known path
		// (token refresh itself is covered separately in github-client.test.ts).
		await env.OAUTH_KV.delete(`github:tokens:${props.login}`);
	});

	it("wraps a successful call's return value with ok()", async () => {
		const result = await withOctokit(env, props, async () => ({ hello: "world" }));
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ hello: "world" }, null, 2) },
		]);
	});

	it("converts ReauthorizationRequiredError into a fail() result instead of throwing", async () => {
		const result = await withOctokit(env, props, async () => {
			throw new ReauthorizationRequiredError(props.login);
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("re-authorize"),
		});
	});

	it("formats a generic Octokit-shaped error (with a status) as a GitHub API error", async () => {
		const result = await withOctokit(env, props, async () => {
			const error = new Error("Not Found") as Error & { status: number };
			error.status = 404;
			throw error;
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "GitHub API error (404): Not Found",
		});
	});

	it("formats an error without a status, omitting the parenthetical", async () => {
		const result = await withOctokit(env, props, async () => {
			throw new Error("network exploded");
		});
		expect(result.content[0]).toEqual({
			type: "text",
			text: "GitHub API error: network exploded",
		});
	});

	it("stringifies a thrown non-Error value rather than crashing", async () => {
		const result = await withOctokit(env, props, async () => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw "just a string";
		});
		expect(result.content[0]).toEqual({
			type: "text",
			text: "GitHub API error: just a string",
		});
	});

	it("never throws out of the wrapper, even on catastrophic failure", async () => {
		await expect(
			withOctokit(env, props, async () => {
				throw new Error("boom");
			}),
		).resolves.toMatchObject({ isError: true });
	});
});
