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

async function getFreshAccessToken(env: Env, props: Props): Promise<string> {
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
		// GitHub rejected the refresh — most likely the user revoked access.
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

/** Construct an Octokit client authenticated with a guaranteed-fresh token. */
export async function getOctokit(env: Env, props: Props): Promise<Octokit> {
	const accessToken = await getFreshAccessToken(env, props);
	return new Octokit({ auth: accessToken });
}
