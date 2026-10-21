import { Octokit } from "octokit";
import { refreshUpstreamToken } from "./oauth/utils";
import type { Props, StoredGitHubToken } from "./types";

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 minutes before the 8h token actually expires

/**
 * Thrown when the stored refresh token itself has expired or been revoked
 * (user uninstalled the GitHub App, rotated credentials, or simply didn't
 * use this server for 6+ months). The only recovery is a fresh consent
 * flow — there's no token-only fix at this point.
 */
export class ReauthorizationRequiredError extends Error {
	constructor(login: string) {
		super(
			`GitHub authorization for "${login}" has expired and could not be refreshed. ` +
				`Disconnect and reconnect this MCP server in your client to re-authorize.`,
		);
		this.name = "ReauthorizationRequiredError";
	}
}

export async function getFreshAccessToken(env: Env, props: Props): Promise<string> {
	const key = `github:tokens:${props.login}`;
	const raw = await env.OAUTH_KV.get(key);

	// Should only happen if KV was cleared independently of the MCP grant.
	// Fall back to the bootstrap token from props rather than hard-failing —
	// it may still be valid for a few more hours.
	if (!raw) return props.accessToken;

	const stored = JSON.parse(raw) as StoredGitHubToken;

	if (Date.now() < stored.accessTokenExpiresAt - REFRESH_MARGIN_MS) {
		return stored.accessToken;
	}

	if (Date.now() >= stored.refreshTokenExpiresAt) {
		throw new ReauthorizationRequiredError(props.login);
	}

	const [refreshed, errResponse] = await refreshUpstreamToken({
		upstream_url: GITHUB_TOKEN_URL,
		client_id: env.GITHUB_APP_CLIENT_ID,
		client_secret: env.GITHUB_APP_CLIENT_SECRET,
		refresh_token: stored.refreshToken,
	});

	if (errResponse || !refreshed) {
		// GitHub refresh tokens are single-use, and this key is shared by every
		// session for the login. If another session refreshed concurrently, it
		// consumed our token and stored the successor, so GitHub rejects ours
		// although the stored pair is valid. Check for that before telling the
		// user to reconnect — a reconnect can revoke the other sessions' grants.
		const successor = await rotatedElsewhere(env, key, stored.refreshToken);
		if (successor) return successor;
		// Nobody else rotated it — most likely the user revoked access.
		throw new ReauthorizationRequiredError(props.login);
	}

	const now = Date.now();
	const next: StoredGitHubToken = {
		accessToken: refreshed.accessToken,
		refreshToken: refreshed.refreshToken,
		accessTokenExpiresAt: now + refreshed.expiresInSeconds * 1000,
		refreshTokenExpiresAt: now + refreshed.refreshTokenExpiresInSeconds * 1000,
	};
	await env.OAUTH_KV.put(key, JSON.stringify(next));

	return next.accessToken;
}

const SUCCESSOR_READS = 3;
const SUCCESSOR_READ_DELAY_MS = 250;

/**
 * Re-read the stored pair after a failed refresh. Returns the access token a
 * concurrent refresher stored, or null if the pair still holds the token we
 * used. Retries briefly because the winner's write may land after GitHub
 * rejected us. KV has no compare-and-swap, so this narrows the race; it cannot
 * close it (a stale cross-location read can still miss the successor).
 */
async function rotatedElsewhere(env: Env, key: string, usedRefreshToken: string): Promise<string | null> {
	for (let attempt = 0; attempt < SUCCESSOR_READS; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SUCCESSOR_READ_DELAY_MS));
		const raw = await env.OAUTH_KV.get(key);
		if (!raw) return null;
		const current = JSON.parse(raw) as StoredGitHubToken;
		if (current.refreshToken !== usedRefreshToken && Date.now() < current.accessTokenExpiresAt) {
			return current.accessToken;
		}
	}
	return null;
}

/** Construct an Octokit client authenticated with a guaranteed-fresh token. */
export async function getOctokit(env: Env, props: Props): Promise<Octokit> {
	const accessToken = await getFreshAccessToken(env, props);
	return new Octokit({ auth: accessToken });
}
