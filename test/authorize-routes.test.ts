import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubHandler } from "../src/oauth/github-handler";
import { addApprovedClient, generateCSRFProtection } from "../src/oauth/workers-oauth-utils";

/**
 * Covers the `GET`/`POST /authorize` route wiring that CLAUDE.md previously
 * listed as the one untested path. github-handler.test.ts probes /callback
 * only, and the unit suites prove the CSRF / approved-client / state helpers
 * are individually correct -- neither proves they are actually CALLED, in the
 * right order, before the side effects they exist to prevent.
 *
 * Specifically at stake here:
 *   - a malformed authorization request must surface as a 4xx client error,
 *     not an opaque 500 (RFC 6749 s4.1.2.1: an untrusted client_id or
 *     redirect_uri must NOT be redirected back to the client)
 *   - the consent screen must be skippable ONLY via a validly-signed
 *     approved-clients cookie
 *   - POST must reject on CSRF mismatch BEFORE it mints state or marks the
 *     client approved
 *   - the happy path must set BOTH cookies (approved-clients + session
 *     binding), since /callback rejects the flow without the latter
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

const executionCtx: ExecutionContext = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: undefined,
} as unknown as ExecutionContext;

const oauthReqInfo = {
	responseType: "code",
	clientId: "test-client",
	redirectUri: "https://client.example/cb",
	scope: ["repo"],
	state: "client-opaque-state",
} as unknown as AuthRequest;

function fakeProvider(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
	return {
		parseAuthRequest: vi.fn(async () => oauthReqInfo),
		lookupClient: vi.fn(async () => ({ clientId: "test-client", clientName: "Test MCP Client" })),
		completeAuthorization: vi.fn(),
		createClient: vi.fn(),
		listClients: vi.fn(),
		updateClient: vi.fn(),
		disableClient: vi.fn(),
		listUserGrants: vi.fn(),
		revokeGrant: vi.fn(),
		...overrides,
	} as unknown as OAuthHelpers;
}

/** First name=value pair of a Set-Cookie header, ready to send back as `Cookie`. */
function cookiePair(setCookie: string): string {
	return setCookie.split(";")[0];
}

function setCookies(response: Response): string[] {
	return response.headers.getSetCookie();
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GET /authorize", () => {
	it("returns 400, not 500, when parseAuthRequest rejects the request", async () => {
		const provider = fakeProvider({
			parseAuthRequest: vi.fn(async () => {
				throw new Error("Unregistered redirect URI");
			}),
		});

		const response = await GitHubHandler.fetch(
			new Request("https://worker.example/authorize?client_id=bogus"),
			{ ...env, OAUTH_PROVIDER: provider },
			executionCtx,
		);

		// A bad client_id/redirect_uri must be shown to the user agent rather
		// than redirected back to an untrusted client.
		expect(response.status).toBe(400);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).toContain("Unregistered redirect URI");
	});

	it("renders the consent screen with a CSRF token + cookie for an unapproved client", async () => {
		const provider = fakeProvider();

		const response = await GitHubHandler.fetch(
			new Request("https://worker.example/authorize?client_id=test-client"),
			{ ...env, OAUTH_PROVIDER: provider },
			executionCtx,
		);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Test MCP Client");

		const csrfCookie = setCookies(response).find((c) => c.startsWith("__Host-CSRF_TOKEN="));
		expect(csrfCookie).toBeDefined();
		// The form token and the cookie token must be the same value, or the
		// POST leg can never validate.
		const cookieToken = cookiePair(csrfCookie as string).split("=")[1];
		expect(html).toContain(cookieToken);

		// No redirect to GitHub happens until the user consents.
		expect(provider.lookupClient).toHaveBeenCalledWith("test-client");
	});

	it("skips the consent screen and redirects to GitHub when the approved-clients cookie is validly signed", async () => {
		const approvedCookie = await addApprovedClient(
			new Request("https://worker.example/authorize"),
			"test-client",
			env.COOKIE_ENCRYPTION_KEY,
		);

		const response = await GitHubHandler.fetch(
			new Request("https://worker.example/authorize?client_id=test-client", {
				headers: { Cookie: cookiePair(approvedCookie) },
			}),
			{ ...env, OAUTH_PROVIDER: fakeProvider() },
			executionCtx,
		);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location") ?? "";
		expect(location.startsWith(GITHUB_AUTHORIZE_URL)).toBe(true);

		const params = new URL(location).searchParams;
		expect(params.get("client_id")).toBe(env.GITHUB_APP_CLIENT_ID);
		expect(params.get("redirect_uri")).toBe("https://worker.example/callback");

		// The state token is server-side and one-time-use: it must exist in KV
		// before the user agent is sent upstream.
		const stateToken = params.get("state") as string;
		expect(stateToken).toBeTruthy();
		expect(await env.OAUTH_KV.get(`oauth:state:${stateToken}`)).not.toBeNull();

		// And the browser must be bound to that state, or /callback rejects it.
		expect(setCookies(response).some((c) => c.startsWith("__Host-CONSENTED_STATE="))).toBe(true);
	});

	it("ignores a forged approved-clients cookie and falls back to the consent screen", async () => {
		const forged = `__Host-APPROVED_CLIENTS=deadbeef.${btoa(JSON.stringify(["test-client"]))}`;

		const response = await GitHubHandler.fetch(
			new Request("https://worker.example/authorize?client_id=test-client", {
				headers: { Cookie: forged },
			}),
			{ ...env, OAUTH_PROVIDER: fakeProvider() },
			executionCtx,
		);

		// Bad HMAC => treated as unapproved, not as approved-and-trusted.
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
	});
});

describe("POST /authorize", () => {
	async function postConsent(options: {
		csrfFormToken?: string;
		csrfCookieToken?: string;
		state?: string;
	}): Promise<Response> {
		const form = new FormData();
		if (options.csrfFormToken !== undefined) form.set("csrf_token", options.csrfFormToken);
		if (options.state !== undefined) form.set("state", options.state);

		const headers: Record<string, string> = {};
		if (options.csrfCookieToken !== undefined) {
			headers.Cookie = `__Host-CSRF_TOKEN=${options.csrfCookieToken}`;
		}

		return GitHubHandler.fetch(
			new Request("https://worker.example/authorize", { method: "POST", body: form, headers }),
			{ ...env, OAUTH_PROVIDER: fakeProvider() },
			executionCtx,
		);
	}

	const validState = btoa(JSON.stringify({ oauthReqInfo }));

	it("rejects a CSRF token that does not match the cookie, before minting any state", async () => {
		const before = (await env.OAUTH_KV.list({ prefix: "oauth:state:" })).keys.length;

		const response = await postConsent({
			csrfFormToken: "attacker-supplied",
			csrfCookieToken: "real-session-token",
			state: validState,
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("CSRF token mismatch");

		// The rejection must happen BEFORE the side effects, so nothing is
		// approved and no state is issued.
		expect(setCookies(response).some((c) => c.startsWith("__Host-APPROVED_CLIENTS="))).toBe(false);
		expect((await env.OAUTH_KV.list({ prefix: "oauth:state:" })).keys.length).toBe(before);
	});

	it("rejects a missing CSRF cookie (no cookie at all is not a pass)", async () => {
		const response = await postConsent({ csrfFormToken: "anything", state: validState });
		expect(response.status).toBe(400);
	});

	it("rejects missing state even when CSRF validates", async () => {
		const { token } = generateCSRFProtection();
		const response = await postConsent({ csrfFormToken: token, csrfCookieToken: token });

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Missing state");
	});

	it("rejects state that is not decodable JSON", async () => {
		const { token } = generateCSRFProtection();
		const response = await postConsent({
			csrfFormToken: token,
			csrfCookieToken: token,
			state: "!!!not-base64!!!",
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Invalid state data");
	});

	it("rejects well-formed state that carries no clientId", async () => {
		const { token } = generateCSRFProtection();
		const response = await postConsent({
			csrfFormToken: token,
			csrfCookieToken: token,
			state: btoa(JSON.stringify({ oauthReqInfo: { responseType: "code" } })),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Invalid request");
	});

	it("on consent: redirects to GitHub and sets BOTH the approved-clients and session-binding cookies", async () => {
		const { token } = generateCSRFProtection();
		const response = await postConsent({
			csrfFormToken: token,
			csrfCookieToken: token,
			state: validState,
		});

		expect(response.status).toBe(302);
		const location = response.headers.get("Location") ?? "";
		expect(location.startsWith(GITHUB_AUTHORIZE_URL)).toBe(true);

		const cookies = setCookies(response);
		// Both are load-bearing: without the approved-clients cookie the user
		// re-consents every time; without the session binding, /callback 403s.
		expect(cookies.some((c) => c.startsWith("__Host-APPROVED_CLIENTS="))).toBe(true);
		expect(cookies.some((c) => c.startsWith("__Host-CONSENTED_STATE="))).toBe(true);

		// Every cookie this route issues must carry the __Host- guarantees.
		for (const cookie of cookies) {
			expect(cookie).toMatch(/^__Host-/);
			expect(cookie).toContain("Secure");
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("Path=/");
			expect(cookie).not.toContain("Domain=");
		}

		const stateToken = new URL(location).searchParams.get("state") as string;
		expect(await env.OAUTH_KV.get(`oauth:state:${stateToken}`)).not.toBeNull();
	});
});
