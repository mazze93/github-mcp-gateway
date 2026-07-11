/**
 * Props attached to the MCP-client-facing access token by
 * `OAUTH_PROVIDER.completeAuthorization()`. Available inside the Durable
 * Object as `this.props`. These are fixed at issuance time — they do NOT
 * update when the underlying GitHub token is refreshed. For that reason,
 * tool code must treat `accessToken` here as a *bootstrap* value only and
 * always resolve the live token through `getFreshAccessToken()` in
 * `src/github-client.ts`, which reads the current value from KV.
 */
export interface Props extends Record<string, unknown> {
	login: string;
	name: string | null;
	email: string | null;
	accessToken: string;
}

/**
 * What we persist in OAUTH_KV under `github:tokens:{login}`. This is the
 * source of truth for the live GitHub access token — refreshed in place
 * whenever it's within five minutes of expiry. Storing it separately from
 * the OAuth `props` is what lets a single MCP grant (which may live for
 * weeks) survive many 8-hour GitHub token cycles without forcing the user
 * back through the GitHub consent screen.
 */
export interface StoredGitHubToken {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	accessTokenExpiresAt: number;
	/** Epoch milliseconds. */
	refreshTokenExpiresAt: number;
}
