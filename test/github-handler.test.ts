import { env } from "cloudflare:workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubHandler } from "../src/oauth/github-handler";
import { bindStateToSession, createOAuthState } from "../src/oauth/workers-oauth-utils";
import type { StoredGitHubToken } from "../src/types";

/**
 * Probes the seam allowlist.test.ts and workers-oauth-utils.test.ts cannot
 * reach: is the allowlist gate actually WIRED correctly into the live
 * /callback route -- right args, right order, short-circuits before any
 * token is persisted or any grant is completed? Unit-testing isLoginAllowed()
 * in isolation proves the gate logic is correct; it does not prove the gate
 * is actually consulted, or consulted before the side effects it's meant to
 * prevent.
 *
 * env.ALLOWED_GITHUB_LOGINS comes from the real wrangler.jsonc `vars`
 * (loaded via vitest.config.ts's wrangler.configPath) -- currently "mazze93".
 */

const executionCtx: ExecutionContext = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: undefined,
} as unknown as ExecutionContext;

function fakeProvider(): OAuthHelpers & { completeAuthorization: ReturnType<typeof vi.fn> } {
	return {
		parseAuthRequest: vi.fn(),
		lookupClient: vi.fn(),
		completeAuthorization: vi.fn(async () => ({ redirectTo: "https://client.example/done" })),
		createClient: vi.fn(),
		listClients: vi.fn(),
		updateClient: vi.fn(),
		disableClient: vi.fn(),
		listUserGrants: vi.fn(),
		revokeGrant: vi.fn(),
	} as unknown as OAuthHelpers & { completeAuthorization: ReturnType<typeof vi.fn> };
}

async function callbackRequest(): Promise<{ request: Request; kvKeyPrefix: string }> {
	const oauthReqInfo = {
		responseType: "code",
		clientId: "test-client",
		redirectUri: "https://client.example/cb",
		scope: ["repo"],
		state: "client-opaque-state",
	};
	const { stateToken } = await createOAuthState(oauthReqInfo as never, env.OAUTH_KV);
	const { setCookie } = await bindStateToSession(stateToken);
	const cookieHeader = setCookie.split(";")[0];
	const request = new Request(
		`https://worker.example/callback?code=upstream-code-123&state=${stateToken}`,
		{ headers: { Cookie: cookieHeader } },
	);
	return { request, kvKeyPrefix: "github:tokens:" };
}

function mockUpstream(login: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith("https://github.com/login/oauth/access_token")) {
				return Response.json({
					access_token: "gh-access-token",
					refresh_token: "gh-refresh-token",
					expires_in: 8 * 60 * 60,
					refresh_token_expires_in: 180 * 24 * 60 * 60,
				});
			}
			if (url.startsWith("https://api.github.com/user")) {
				return Response.json({ login, name: `${login} display name`, email: null });
			}
			throw new Error(`Unexpected fetch to ${url} in test`);
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

beforeEach(async () => {
	// Nothing to reset in OAUTH_KV up front -- each test creates its own
	// unique state token via createOAuthState, so there's no cross-test key
	// collision to worry about.
});

describe("GET /callback -- allowlist gate, wired end-to-end", () => {
	it("REJECTS a disallowed login with 403, and never persists a token or completes the grant", async () => {
		mockUpstream("attacker");
		const provider = fakeProvider();
		const { request } = await callbackRequest();

		const response = await GitHubHandler.fetch(
			request,
			{ ...env, OAUTH_PROVIDER: provider },
			executionCtx,
		);

		expect(response.status).toBe(403);
		const body = await response.text();
		expect(body).toContain("attacker");
		expect(body).toContain("not on this server's allowlist");

		expect(await env.OAUTH_KV.get("github:tokens:attacker")).toBeNull();
		expect(provider.completeAuthorization).not.toHaveBeenCalled();
	});

	it("ACCEPTS an allowed login: persists the token pair and completes the grant with the right props", async () => {
		mockUpstream("mazze93");
		const provider = fakeProvider();
		const { request } = await callbackRequest();

		const response = await GitHubHandler.fetch(
			request,
			{ ...env, OAUTH_PROVIDER: provider },
			executionCtx,
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://client.example/done");

		const stored = JSON.parse(
			(await env.OAUTH_KV.get("github:tokens:mazze93")) ?? "null",
		) as StoredGitHubToken;
		expect(stored.accessToken).toBe("gh-access-token");
		expect(stored.refreshToken).toBe("gh-refresh-token");

		expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
		const call = provider.completeAuthorization.mock.calls[0][0];
		expect(call.userId).toBe("mazze93");
		expect(call.props).toMatchObject({
			login: "mazze93",
			name: "mazze93 display name",
			email: null,
			accessToken: "gh-access-token",
		});
	});

	it("allowlist check runs case-insensitively through the real route, matching the unit-level contract", async () => {
		mockUpstream("Mazze93"); // GitHub-reported casing can vary; allowlist entry is lowercase "mazze93"
		const provider = fakeProvider();
		const { request } = await callbackRequest();

		const response = await GitHubHandler.fetch(
			request,
			{ ...env, OAUTH_PROVIDER: provider },
			executionCtx,
		);

		expect(response.status).toBe(302);
		expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
	});
});
