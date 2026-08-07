import { env } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
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
} from "../src/oauth/workers-oauth-utils";

const COOKIE_SECRET = "test-cookie-encryption-key-not-real";

/** Set-Cookie is "name=value; Attr; Attr" -- a request Cookie header wants just "name=value". */
function asCookieHeader(...setCookies: string[]): string {
	return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function fakeAuthRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
	return {
		responseType: "code",
		clientId: "client-abc",
		redirectUri: "https://example.com/callback",
		scope: ["repo"],
		state: "client-state-xyz",
		...overrides,
	};
}

describe("CSRF protection", () => {
	it("accepts a form token that matches the cookie", () => {
		const { token, setCookie } = generateCSRFProtection();
		const request = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(setCookie) },
		});
		const formData = new FormData();
		formData.set("csrf_token", token);
		expect(() => validateCSRFToken(formData, request)).not.toThrow();
	});

	it("rejects a form token that does not match the cookie", () => {
		const { setCookie } = generateCSRFProtection();
		const request = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(setCookie) },
		});
		const formData = new FormData();
		formData.set("csrf_token", "attacker-supplied-token");
		expect(() => validateCSRFToken(formData, request)).toThrow(OAuthError);
	});

	it("rejects when there is no CSRF cookie at all (e.g. cross-site submission)", () => {
		const request = new Request("https://worker.example/authorize");
		const formData = new FormData();
		formData.set("csrf_token", "anything");
		expect(() => validateCSRFToken(formData, request)).toThrow(OAuthError);
	});

	it("rejects when the form is missing the token", () => {
		const { setCookie } = generateCSRFProtection();
		const request = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(setCookie) },
		});
		expect(() => validateCSRFToken(new FormData(), request)).toThrow(OAuthError);
	});
});

describe("OAuth state (KV-backed, one-time use)", () => {
	it("round-trips: create -> bind -> validate returns the same AuthRequest", async () => {
		const oauthReqInfo = fakeAuthRequest();
		const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
		const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

		const request = new Request(`https://worker.example/callback?state=${stateToken}`, {
			headers: { Cookie: asCookieHeader(sessionCookie) },
		});
		const { oauthReqInfo: recovered } = await validateOAuthState(request, env.OAUTH_KV);
		expect(recovered).toEqual(oauthReqInfo);
	});

	it("is one-time use: a second validate with the same state fails", async () => {
		const oauthReqInfo = fakeAuthRequest();
		const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
		const { setCookie: sessionCookie } = await bindStateToSession(stateToken);
		const request = new Request(`https://worker.example/callback?state=${stateToken}`, {
			headers: { Cookie: asCookieHeader(sessionCookie) },
		});

		await validateOAuthState(request, env.OAUTH_KV); // first use succeeds
		await expect(validateOAuthState(request, env.OAUTH_KV)).rejects.toThrow(OAuthError);
	});

	it("rejects a state token with no matching session-binding cookie", async () => {
		const { stateToken } = await createOAuthState(fakeAuthRequest(), env.OAUTH_KV);
		const request = new Request(`https://worker.example/callback?state=${stateToken}`);
		await expect(validateOAuthState(request, env.OAUTH_KV)).rejects.toThrow(OAuthError);
	});

	it("rejects when the session cookie is bound to a DIFFERENT state token", async () => {
		// This is the cross-session-splice attack bindStateToSession() defends
		// against: an attacker's own valid state token, planted in a victim's
		// browser, must not be accepted just because *a* session cookie exists.
		const { stateToken: victimState } = await createOAuthState(fakeAuthRequest(), env.OAUTH_KV);
		const { setCookie: attackerSessionCookie } = await bindStateToSession("attacker-own-state-token");

		const request = new Request(`https://worker.example/callback?state=${victimState}`, {
			headers: { Cookie: asCookieHeader(attackerSessionCookie) },
		});
		await expect(validateOAuthState(request, env.OAUTH_KV)).rejects.toThrow(OAuthError);
	});

	it("rejects a missing state parameter", async () => {
		const request = new Request("https://worker.example/callback");
		await expect(validateOAuthState(request, env.OAUTH_KV)).rejects.toThrow(OAuthError);
	});

	it("rejects an unknown/expired state token even with a validly-bound cookie", async () => {
		const bogusToken = "00000000-0000-0000-0000-000000000000";
		const { setCookie: sessionCookie } = await bindStateToSession(bogusToken);
		const request = new Request(`https://worker.example/callback?state=${bogusToken}`, {
			headers: { Cookie: asCookieHeader(sessionCookie) },
		});
		await expect(validateOAuthState(request, env.OAUTH_KV)).rejects.toThrow(OAuthError);
	});
});

describe("approved-clients cookie (signed, tamper-evident)", () => {
	it("is not approved with no cookie present", async () => {
		const request = new Request("https://worker.example/authorize");
		expect(await isClientApproved(request, "client-abc", COOKIE_SECRET)).toBe(false);
	});

	it("round-trips: addApprovedClient's cookie makes isClientApproved true for that client", async () => {
		const setCookie = await addApprovedClient(
			new Request("https://worker.example/authorize"),
			"client-abc",
			COOKIE_SECRET,
		);
		const request = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(setCookie) },
		});
		expect(await isClientApproved(request, "client-abc", COOKIE_SECRET)).toBe(true);
		expect(await isClientApproved(request, "some-other-client", COOKIE_SECRET)).toBe(false);
	});

	it("accumulates approvals across calls instead of overwriting", async () => {
		const first = await addApprovedClient(
			new Request("https://worker.example/authorize"),
			"client-a",
			COOKIE_SECRET,
		);
		const requestAfterFirst = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(first) },
		});
		const second = await addApprovedClient(requestAfterFirst, "client-b", COOKIE_SECRET);

		const requestAfterBoth = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(second) },
		});
		expect(await isClientApproved(requestAfterBoth, "client-a", COOKIE_SECRET)).toBe(true);
		expect(await isClientApproved(requestAfterBoth, "client-b", COOKIE_SECRET)).toBe(true);
	});

	it("treats a tampered cookie payload as unapproved rather than trusting it", async () => {
		const setCookie = await addApprovedClient(
			new Request("https://worker.example/authorize"),
			"client-abc",
			COOKIE_SECRET,
		);
		const cookieValue = asCookieHeader(setCookie); // "__Host-APPROVED_CLIENTS=<sig>.<payload>"
		const [name, signed] = cookieValue.split("=");
		const [sig] = signed.split(".");
		// Flip the payload to claim approval for a client that was never approved,
		// keeping the (now invalid) original signature.
		const forgedPayload = btoa(JSON.stringify(["client-abc", "injected-client"]));
		const forged = `${name}=${sig}.${forgedPayload}`;

		const request = new Request("https://worker.example/authorize", { headers: { Cookie: forged } });
		expect(await isClientApproved(request, "injected-client", COOKIE_SECRET)).toBe(false);
		// Even the originally-approved client reads as unapproved once the
		// payload no longer matches its signature -- the whole cookie is
		// discarded on mismatch, not partially trusted.
		expect(await isClientApproved(request, "client-abc", COOKIE_SECRET)).toBe(false);
	});

	it("treats a cookie signed with a different secret as unapproved", async () => {
		const setCookie = await addApprovedClient(
			new Request("https://worker.example/authorize"),
			"client-abc",
			"a-different-secret",
		);
		const request = new Request("https://worker.example/authorize", {
			headers: { Cookie: asCookieHeader(setCookie) },
		});
		expect(await isClientApproved(request, "client-abc", COOKIE_SECRET)).toBe(false);
	});
});

describe("renderApprovalDialog", () => {
	it("renders 200 HTML with the CSRF cookie attached", () => {
		const response = renderApprovalDialog(new Request("https://worker.example/authorize"), {
			client: { clientId: "abc", redirectUris: ["https://example.com/cb"], clientName: "Normal Client" },
			csrfToken: "tok-123",
			server: { name: "GitHub MCP Gateway", description: "desc" },
			setCookie: "__Host-CSRF_TOKEN=tok-123; HttpOnly",
			state: { oauthReqInfo: fakeAuthRequest() },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(response.headers.get("Set-Cookie")).toBe("__Host-CSRF_TOKEN=tok-123; HttpOnly");
	});

	it("HTML-escapes an untrusted client name instead of injecting it raw", async () => {
		const response = renderApprovalDialog(new Request("https://worker.example/authorize"), {
			client: {
				clientId: "abc",
				redirectUris: ["https://example.com/cb"],
				clientName: '<script>alert("xss")</script>',
			},
			csrfToken: "tok-123",
			server: { name: "GitHub MCP Gateway", description: "desc" },
			setCookie: "__Host-CSRF_TOKEN=tok-123; HttpOnly",
			state: { oauthReqInfo: fakeAuthRequest() },
		});
		const html = await response.text();
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
	});

	it("falls back to a generic label when the client has no name", async () => {
		const response = renderApprovalDialog(new Request("https://worker.example/authorize"), {
			client: null,
			csrfToken: "tok-123",
			server: { name: "GitHub MCP Gateway", description: "desc" },
			setCookie: "__Host-CSRF_TOKEN=tok-123; HttpOnly",
			state: { oauthReqInfo: fakeAuthRequest() },
		});
		const html = await response.text();
		expect(html).toContain("An MCP client");
	});
});
