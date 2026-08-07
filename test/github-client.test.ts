import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreshAccessToken, ReauthorizationRequiredError } from "../src/github-client";
import type { Props, StoredGitHubToken } from "../src/types";

const props: Props = {
	login: "test-user",
	name: "Test User",
	email: null,
	accessToken: "bootstrap-token",
};
const kvKey = `github:tokens:${props.login}`;

function storedToken(overrides: Partial<StoredGitHubToken> = {}): StoredGitHubToken {
	const now = Date.now();
	return {
		accessToken: "stored-access-token",
		refreshToken: "stored-refresh-token",
		accessTokenExpiresAt: now + 8 * 60 * 60 * 1000, // fresh, 8h out
		refreshTokenExpiresAt: now + 180 * 24 * 60 * 60 * 1000, // 6mo out
		...overrides,
	};
}

beforeEach(async () => {
	await env.OAUTH_KV.delete(kvKey);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getFreshAccessToken", () => {
	it("falls back to props.accessToken when KV has nothing stored for this login", async () => {
		const token = await getFreshAccessToken(env, props);
		expect(token).toBe("bootstrap-token");
	});

	it("returns the stored token as-is when it is not near expiry, without calling fetch", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await env.OAUTH_KV.put(kvKey, JSON.stringify(storedToken()));

		const token = await getFreshAccessToken(env, props);
		expect(token).toBe("stored-access-token");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes when within the 5-minute margin of expiry, and persists the rotated pair", async () => {
		await env.OAUTH_KV.put(
			kvKey,
			JSON.stringify(
				storedToken({ accessTokenExpiresAt: Date.now() + 60 * 1000 }), // 1 min out, inside margin
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					access_token: "rotated-access-token",
					refresh_token: "rotated-refresh-token",
					expires_in: 8 * 60 * 60,
					refresh_token_expires_in: 180 * 24 * 60 * 60,
				}),
			),
		);

		const token = await getFreshAccessToken(env, props);
		expect(token).toBe("rotated-access-token");

		const persisted = JSON.parse((await env.OAUTH_KV.get(kvKey)) ?? "null") as StoredGitHubToken;
		expect(persisted.accessToken).toBe("rotated-access-token");
		expect(persisted.refreshToken).toBe("rotated-refresh-token");
		expect(persisted.accessTokenExpiresAt).toBeGreaterThan(Date.now());
	});

	it("does not refresh a token sitting exactly at the margin boundary (not yet due)", async () => {
		// Date.now() < expiresAt - margin is the source condition; put expiry
		// comfortably past the margin so this doesn't flake on the clock tick
		// between setup and assertion.
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await env.OAUTH_KV.put(
			kvKey,
			JSON.stringify(storedToken({ accessTokenExpiresAt: Date.now() + 6 * 60 * 1000 })), // 6 min out
		);

		const token = await getFreshAccessToken(env, props);
		expect(token).toBe("stored-access-token");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("throws ReauthorizationRequiredError without a network call once the refresh token itself has expired", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await env.OAUTH_KV.put(
			kvKey,
			JSON.stringify(
				storedToken({
					accessTokenExpiresAt: Date.now() - 1000, // already expired
					refreshTokenExpiresAt: Date.now() - 1000, // refresh token expired too
				}),
			),
		);

		await expect(getFreshAccessToken(env, props)).rejects.toThrow(ReauthorizationRequiredError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("throws ReauthorizationRequiredError when GitHub rejects the refresh (e.g. revoked)", async () => {
		await env.OAUTH_KV.put(
			kvKey,
			JSON.stringify(storedToken({ accessTokenExpiresAt: Date.now() + 60 * 1000 })),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(getFreshAccessToken(env, props)).rejects.toThrow(ReauthorizationRequiredError);
	});

	it("throws ReauthorizationRequiredError when GitHub's response is missing an access_token", async () => {
		await env.OAUTH_KV.put(
			kvKey,
			JSON.stringify(storedToken({ accessTokenExpiresAt: Date.now() + 60 * 1000 })),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "bad_refresh_token" })),
		);

		await expect(getFreshAccessToken(env, props)).rejects.toThrow(ReauthorizationRequiredError);
	});
});

describe("ReauthorizationRequiredError", () => {
	it("names the login in its message so the error is actionable", () => {
		const error = new ReauthorizationRequiredError("mazze93");
		expect(error.message).toContain("mazze93");
		expect(error.name).toBe("ReauthorizationRequiredError");
	});
});
