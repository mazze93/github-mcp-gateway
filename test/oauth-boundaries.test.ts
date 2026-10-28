import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { addApprovedClient } from "../src/oauth/workers-oauth-utils";

const ORIGIN = "https://gateway.example";
const OTHER_ORIGIN = "https://other-gateway.example";
const VERIFIER = "a".repeat(43);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function call(path: string, init?: RequestInit, origin = ORIGIN) {
	return worker.fetch(new Request(`${origin}${path}`, init), env, ctx);
}

async function register(redirectUri: string) {
	const response = await call("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "Boundary test",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { client_id: string }).client_id;
}

async function authorize(clientId: string, redirectUri: string) {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	// A previously approved browser; provider parsing and the GitHub callback
	// remain real. Only the two upstream GitHub HTTP requests are mocked.
	const approved = await addApprovedClient(new Request(ORIGIN), clientId, env.COOKIE_ENCRYPTION_KEY);
	return call(`/authorize?${new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: ORIGIN,
		state: "client-state",
	})}`, { headers: { Cookie: approved.split(";")[0] } });
}

async function mint(registeredUri = "http://127.0.0.1/callback", redirectUri = "http://127.0.0.1:54321/callback") {
	const clientId = await register(registeredUri);
	const authorization = await authorize(clientId, redirectUri);
	expect(authorization.status).toBe(302);
	const upstream = new URL(authorization.headers.get("Location")!);
	const cookie = authorization.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === "https://github.com/login/oauth/access_token") {
			return Response.json({ access_token: "fixture-github-token", refresh_token: "fixture-refresh-token",
				expires_in: 28800, refresh_token_expires_in: 15552000 });
		}
		if (url === "https://api.github.com/user") {
			return Response.json({ login: "mazze93", name: "Test user", email: null });
		}
		throw new Error(`Unexpected upstream request: ${url}`);
	}));
	const callback = await call(`/callback?${new URLSearchParams({ code: "fixture-code", state: upstream.searchParams.get("state")! })}`,
		{ headers: { Cookie: cookie } });
	expect(callback.status).toBe(302);
	const destination = new URL(callback.headers.get("Location")!);
	expect(destination.origin + destination.pathname).toBe(redirectUri);
	expect(destination.searchParams.get("state")).toBe("client-state");
	const response = await token({ grant_type: "authorization_code", client_id: clientId,
		code: destination.searchParams.get("code")!, code_verifier: VERIFIER, redirect_uri: redirectUri, resource: ORIGIN });
	expect(response.status).toBe(200);
	const pair = await response.json() as { access_token: string; refresh_token: string };
	expect(pair.access_token).toBeTruthy();
	expect(pair.refresh_token).toBeTruthy();
	return { ...pair, clientId };
}

function token(fields: Record<string, string>, origin = ORIGIN) {
	return call("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString() }, origin);
}

afterEach(() => vi.unstubAllGlobals());

describe("OAuth boundaries through the real entrypoint", () => {
	it.each(["localhost", "127.0.0.1", "[::1]"])("completes PKCE with a %s-only registration and an ephemeral port", async (host) => {
		await mint(`http://${host}/callback`, `http://${host}:54321/callback`);
	});

	it.each(["http://localhost.evil.example/callback", "http://127.0.0.1.evil.example/callback", "http://[::2]:54321/callback"])("refuses an unregistered redirect %s without redirecting", async (redirectUri) => {
		const clientId = await register("http://localhost/callback");
		const response = await authorize(clientId, redirectUri);
		expect(response.status).toBe(400);
		expect(response.headers.get("Location")).toBeNull();
	});

	it("returns a client error for a non-form token request", async () => {
		const response = await call("/token", { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ grant_type: "authorization_code", redirect_uri: "http://localhost/callback" }) });
		expect(response.status).toBe(400);
	});

	it("accepts a token on its issuing origin and rejects it on another origin", async () => {
		const pair = await mint();
		const init = { method: "POST", headers: { Authorization: `Bearer ${pair.access_token}`,
			"Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
				protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "boundary-test", version: "1" } } }) };
		const foreign = await call("/mcp", init, OTHER_ORIGIN);
		expect(foreign.status).toBe(401);
		const own = await call("/mcp", init);
		expect(own.status).toBe(200);
		expect(await own.text()).toContain("protocolVersion");
	});

	it("refuses to refresh an origin-bound grant on another origin", async () => {
		const pair = await mint();
		const response = await token({ grant_type: "refresh_token", client_id: pair.clientId,
			refresh_token: pair.refresh_token }, OTHER_ORIGIN);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "invalid_grant" });
		// Failed cross-origin use must not consume the valid refresh token.
		const own = await token({ grant_type: "refresh_token", client_id: pair.clientId,
			refresh_token: pair.refresh_token });
		expect(own.status).toBe(200);
	});

	it("rejects refresh of a legacy grant bound to the old /mcp resource", async () => {
		const pair = await mint();
		// Model the persisted 0.x resource field; keep real encrypted props,
		// refresh-token hashes and wrapped keys from the completed PKCE flow.
		const key = `grant:mazze93:${pair.refresh_token.split(":")[1]}`;
		const grant = await env.OAUTH_KV.get(key, "json") as Record<string, unknown>;
		expect(grant).not.toBeNull();
		expect(grant.resource).toBe(ORIGIN);
		await env.OAUTH_KV.put(key, JSON.stringify({ ...grant, resource: `${ORIGIN}/mcp` }));
		const response = await token({ grant_type: "refresh_token", client_id: pair.clientId,
			refresh_token: pair.refresh_token });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "invalid_grant" });
	});
});
