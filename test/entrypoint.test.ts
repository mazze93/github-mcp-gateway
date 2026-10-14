import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

/**
 * Drives the real default export -- OAuthProvider construction included.
 * workers-oauth-provider 1.x validates its whole configuration (canonical
 * resource, apiHandlers paths under it) when the provider is BUILT, so a
 * config the library rejects only shows up as a thrown first request. Before
 * this file nothing in the suite constructed the provider: the 1.x upgrade
 * (#69) merged with `resourceMetadata` missing and only typecheck noticed.
 */

const ORIGIN = "https://gateway.example";

const ctx: ExecutionContext = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: undefined,
} as unknown as ExecutionContext;

function call(path: string, init?: RequestInit, origin = ORIGIN): Promise<Response> {
	return worker.fetch(new Request(`${origin}${path}`, init), env, ctx);
}

describe("entrypoint (OAuthProvider 1.x)", () => {
	it("publishes the request origin as the one canonical resource", async () => {
		const res = await call("/.well-known/oauth-protected-resource");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { resource: string; authorization_servers: string[] };
		expect(body.resource).toBe(ORIGIN);
		expect(body.authorization_servers).toEqual([ORIGIN]);
	});

	it("binds the resource per origin, not to whichever origin was seen first", async () => {
		const other = "https://fork.example";
		const res = await call("/.well-known/oauth-protected-resource", undefined, other);
		expect(((await res.json()) as { resource: string }).resource).toBe(other);
	});

	it("accepts loopback http so `wrangler dev` still constructs", async () => {
		const local = "http://localhost:8788";
		const res = await call("/.well-known/oauth-protected-resource", undefined, local);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { resource: string }).resource).toBe(local);
	});

	it.each(["/mcp", "/sse"])("%s refuses an unauthenticated caller with a discovery challenge", async (path) => {
		const res = await call(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
		);
	});

	it("still advertises CIMD and DCR in authorization-server metadata", async () => {
		const res = await call("/.well-known/oauth-authorization-server");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.issuer).toBe(ORIGIN);
		expect(body.client_id_metadata_document_supported).toBe(true);
		expect(body.registration_endpoint).toBe(`${ORIGIN}/register`);
		expect(body.token_endpoint).toBe(`${ORIGIN}/token`);
	});
});
