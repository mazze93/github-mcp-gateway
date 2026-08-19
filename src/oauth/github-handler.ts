import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import { isLoginAllowed } from "./allowlist";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";
import type { Props, StoredGitHubToken } from "../types";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	// parseAuthRequest throws on any invalid parameter (unknown client, bad
	// redirect URI, disallowed PKCE method, ...). Those are client errors, not
	// server faults — without this catch they escape as an unhandled exception
	// and the caller sees an opaque 500 instead of the actual reason.
	//
	// RFC 6749 §4.1.2.1: when the client identity or redirect URI cannot be
	// trusted, the error MUST be shown to the user agent rather than redirected
	// back to the client. parseAuthRequest fails precisely in those cases, so
	// returning 400 here is the correct behaviour.
	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		const detail = error instanceof Error ? error.message : "Invalid authorization request";
		return c.text(`invalid_request: ${detail}`, 400);
	}

	const { clientId } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToGitHub(c.req.raw, stateToken, [setCookie]);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			name: "GitHub MCP Gateway",
			description:
				"Connects this MCP client to your GitHub account via a GitHub App. " +
				"You'll pick which repositories to grant access to on GitHub's own installation screen.",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}
		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		return redirectToGitHub(c.req.raw, stateToken, [
			approvedClientCookie,
			sessionBindingCookie,
		]);
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		console.error("POST /authorize error:", error);
		return c.text("Internal server error", 500);
	}
});

/**
 * Takes cookies as a LIST, not as a header object. A `Headers` instance can
 * hold several Set-Cookie values, but collapsing one into a plain object --
 * `Object.fromEntries(headers)` -- keeps only the LAST and silently discards
 * the rest. POST /authorize sets two (approved-clients + session binding), so
 * doing that dropped the approved-clients cookie on every consent and the
 * "remember this client" path never took effect.
 */
function redirectToGitHub(request: Request, stateToken: string, cookies: string[] = []) {
	const headers = new Headers({
		location: getUpstreamAuthorizeUrl({
			upstream_url: GITHUB_AUTHORIZE_URL,
			client_id: env.GITHUB_APP_CLIENT_ID,
			redirect_uri: new URL("/callback", request.url).href,
			state: stateToken,
		}),
	});
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 302, headers });
}

/**
 * OAuth callback from GitHub. Exchanges the code for a token pair, fetches
 * the authenticated user's login, gates against ALLOWED_GITHUB_LOGINS,
 * persists the refresh-capable token to KV (see src/github-client.ts for
 * why this lives in KV rather than solely in `props`), and hands a bound
 * MCP-client token back via completeAuthorization().
 */
app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

	const [token, errResponse] = await fetchUpstreamAuthToken({
		upstream_url: GITHUB_TOKEN_URL,
		client_id: c.env.GITHUB_APP_CLIENT_ID,
		client_secret: c.env.GITHUB_APP_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
	});
	if (errResponse) return errResponse;

	const octokit = new Octokit({ auth: token.accessToken });
	const { data: user } = await octokit.rest.users.getAuthenticated();

	if (!isLoginAllowed(user.login, c.env.ALLOWED_GITHUB_LOGINS)) {
		return c.text(
			`GitHub account "${user.login}" is not on this server's allowlist (ALLOWED_GITHUB_LOGINS). ` +
				`If this is your account, update the worker var and redeploy.`,
			403,
		);
	}

	const now = Date.now();
	const stored: StoredGitHubToken = {
		accessToken: token.accessToken,
		refreshToken: token.refreshToken,
		accessTokenExpiresAt: now + token.expiresInSeconds * 1000,
		refreshTokenExpiresAt: now + token.refreshTokenExpiresInSeconds * 1000,
	};
	await c.env.OAUTH_KV.put(`github:tokens:${user.login}`, JSON.stringify(stored));

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: user.name ?? user.login },
		props: {
			login: user.login,
			name: user.name,
			email: user.email,
			accessToken: token.accessToken,
		} satisfies Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.login,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
	return new Response(null, { status: 302, headers });
});

export { app as GitHubHandler };
