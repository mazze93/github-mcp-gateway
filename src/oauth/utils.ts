/**
 * GitHub App user-to-server OAuth helpers.
 *
 * Note this is deliberately a GitHub *App* flow, not a classic OAuth App:
 * - Repo access is scoped at install time (user picks repos in GitHub's UI),
 *   not via an OAuth `scope` string — GitHub Apps ignore `scope` on
 *   /login/oauth/authorize, permissions live in the app's manifest instead.
 * - With "Expire user authorization tokens" enabled on the app, every
 *   token response includes `refresh_token` + `refresh_token_expires_in`.
 *   That's what makes refreshUpstreamToken() below meaningful — a classic
 *   OAuth App token exchange never returns a refresh token at all.
 */

export interface UpstreamTokenResponse {
	accessToken: string;
	refreshToken: string;
	expiresInSeconds: number;
	refreshTokenExpiresInSeconds: number;
}

interface GitHubTokenPayload {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	error?: string;
	error_description?: string;
}

export function getUpstreamAuthorizeUrl(params: {
	upstream_url: string;
	client_id: string;
	redirect_uri: string;
	state: string;
}): string {
	const url = new URL(params.upstream_url);
	url.searchParams.set("client_id", params.client_id);
	url.searchParams.set("redirect_uri", params.redirect_uri);
	url.searchParams.set("state", params.state);
	return url.href;
}

async function postForToken(
	upstreamUrl: string,
	body: Record<string, string>,
): Promise<[UpstreamTokenResponse, null] | [null, Response]> {
	const resp = await fetch(upstreamUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(body).toString(),
	});

	if (!resp.ok) {
		const text = await resp.text();
		return [null, new Response(`Upstream token request failed: ${resp.status} ${text}`, { status: 502 })];
	}

	const payload = (await resp.json()) as GitHubTokenPayload;

	if (payload.error || !payload.access_token) {
		return [
			null,
			new Response(
				`Upstream token error: ${payload.error ?? "unknown"} — ${payload.error_description ?? "no access_token in response"}`,
				{ status: 502 },
			),
		];
	}

	if (!payload.refresh_token || !payload.expires_in || !payload.refresh_token_expires_in) {
		return [
			null,
			new Response(
				"GitHub did not return a refresh token. Enable 'Expire user authorization tokens' " +
					"in the GitHub App settings (Settings → Developer settings → GitHub Apps → " +
					"[app] → General → Optional features → User-to-server token expiration).",
				{ status: 502 },
			),
		];
	}

	return [
		{
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token,
			expiresInSeconds: payload.expires_in,
			refreshTokenExpiresInSeconds: payload.refresh_token_expires_in,
		},
		null,
	];
}

export async function fetchUpstreamAuthToken(params: {
	upstream_url: string;
	client_id: string;
	client_secret: string;
	code: string | undefined;
	redirect_uri: string;
}): Promise<[UpstreamTokenResponse, null] | [null, Response]> {
	if (!params.code) {
		return [null, new Response("Missing code in callback.", { status: 400 })];
	}
	return postForToken(params.upstream_url, {
		client_id: params.client_id,
		client_secret: params.client_secret,
		code: params.code,
		redirect_uri: params.redirect_uri,
	});
}

export async function refreshUpstreamToken(params: {
	upstream_url: string;
	client_id: string;
	client_secret: string;
	refresh_token: string;
}): Promise<[UpstreamTokenResponse, null] | [null, Response]> {
	return postForToken(params.upstream_url, {
		client_id: params.client_id,
		client_secret: params.client_secret,
		grant_type: "refresh_token",
		refresh_token: params.refresh_token,
	});
}
