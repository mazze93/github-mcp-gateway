import { describe, expect, it } from "vitest";
import { normalizeLoopbackRedirect, normalizeLoopbackRedirectUri } from "../src/oauth/loopback";

describe("normalizeLoopbackRedirectUri", () => {
	it("rewrites http://localhost to http://127.0.0.1", () => {
		expect(normalizeLoopbackRedirectUri("http://localhost/callback")).toBe(
			"http://127.0.0.1/callback",
		);
	});

	it("preserves an ephemeral port", () => {
		expect(normalizeLoopbackRedirectUri("http://localhost:54321/callback")).toBe(
			"http://127.0.0.1:54321/callback",
		);
	});

	it("leaves https://localhost untouched", () => {
		expect(normalizeLoopbackRedirectUri("https://localhost/callback")).toBe(
			"https://localhost/callback",
		);
	});

	it("leaves other hosts untouched", () => {
		expect(normalizeLoopbackRedirectUri("http://example.com/callback")).toBe(
			"http://example.com/callback",
		);
	});

	it("leaves already-canonical 127.0.0.1 untouched", () => {
		expect(normalizeLoopbackRedirectUri("http://127.0.0.1:8080/callback")).toBe(
			"http://127.0.0.1:8080/callback",
		);
	});

	it("returns malformed input unchanged instead of throwing", () => {
		expect(normalizeLoopbackRedirectUri("not-a-uri")).toBe("not-a-uri");
		expect(normalizeLoopbackRedirectUri("")).toBe("");
	});
});

describe("normalizeLoopbackRedirect", () => {
	it("rewrites redirect_uri on GET /authorize", async () => {
		const request = new Request(
			"http://worker.example/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback",
		);
		const normalized = await normalizeLoopbackRedirect(request);
		const url = new URL(normalized.url);
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:12345/callback");
		expect(url.searchParams.get("client_id")).toBe("abc"); // untouched
	});

	it("leaves GET /authorize with no redirect_uri untouched", async () => {
		const request = new Request("http://worker.example/authorize?client_id=abc");
		const normalized = await normalizeLoopbackRedirect(request);
		expect(normalized).toBe(request); // same object, not just equal
	});

	it("rewrites redirect_uri in a form-urlencoded POST /token body", async () => {
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code: "xyz",
			redirect_uri: "http://localhost:9999/callback",
		});
		const request = new Request("http://worker.example/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});
		const normalized = await normalizeLoopbackRedirect(request);
		const parsed = new URLSearchParams(await normalized.text());
		expect(parsed.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
		expect(parsed.get("code")).toBe("xyz"); // untouched
	});

	it("does not consume the body of a POST /token with a non-form content-type", async () => {
		// This is the invalid-param regression the loopback fix addressed
		// (commit 065d3b5): a non-form body must pass through completely
		// unread, or the provider's own body-parsing 500s downstream.
		const request = new Request("http://worker.example/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ redirect_uri: "http://localhost:9999/callback" }),
		});
		const normalized = await normalizeLoopbackRedirect(request);
		expect(normalized).toBe(request);
		// Body must still be readable exactly once downstream — prove it wasn't consumed.
		await expect(normalized.text()).resolves.toContain("localhost");
	});

	it("ignores GET/POST combinations outside /authorize and /token", async () => {
		const request = new Request("http://worker.example/callback?redirect_uri=http://localhost/x");
		const normalized = await normalizeLoopbackRedirect(request);
		expect(normalized).toBe(request);
	});
});
