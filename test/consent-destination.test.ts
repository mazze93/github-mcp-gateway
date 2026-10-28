import { describe, expect, it } from "vitest";
import { classifyRedirect } from "../src/oauth/redirect-trust";
import { renderApprovalDialog } from "../src/oauth/workers-oauth-utils";

describe("classifyRedirect", () => {
	it.each([
		["https://claude.ai/api/mcp/auth_callback", "known"],
		["https://sub.claude.com/cb", "known"],
		["http://127.0.0.1:53682/callback", "loopback"],
		["http://localhost:8080/cb", "loopback"],
		["http://[::1]:9000/cb", "loopback"],
		["https://attacker.example/cb", "unverified"],
	])("%s -> %s", (uri, kind) => {
		expect(classifyRedirect(uri).kind).toBe(kind);
	});

	it.each([
		"https://claude.ai.evil.example/cb", // suffix lookalike
		"https://evilclaude.ai/cb", // prefix lookalike
		"https://claude.ai@evil.example/cb", // userinfo trick: the browser connects to evil.example
		"https://evil.example/claude.ai",
		"http://claude.ai/cb", // right host, wrong scheme: not the first-party callback
	])("does not trust %s", (uri) => {
		expect(classifyRedirect(uri).kind).toBe("unverified");
	});

	it("survives garbage", () => {
		expect(classifyRedirect("not a url").kind).toBe("invalid");
	});
});

describe("consent screen destination", () => {
	const dialog = (redirectUri: string, clientName = "Claude Code") =>
		renderApprovalDialog(new Request("https://gateway.example/authorize"), {
			client: { clientId: "c", redirectUris: [redirectUri], clientName },
			csrfToken: "csrf-value",
			server: { name: "GitHub MCP Gateway", description: "desc" },
			setCookie: "__Host-CSRF_TOKEN=csrf-value; HttpOnly",
			state: { oauthReqInfo: { responseType: "code", clientId: "c", redirectUri, scope: [], state: "s" } },
		}).text();

	it("shows where the code goes and warns when a spoofed name points at an unknown host", async () => {
		const html = await dialog("https://attacker.example/cb");
		expect(html).toContain("Authorization code will be sent to");
		expect(html).toContain("attacker.example");
		expect(html).toContain("Unrecognised destination");
		expect(html).toContain("not verified");
	});

	it("does not warn for a first-party or loopback destination", async () => {
		for (const uri of ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:53682/callback"]) {
			const html = await dialog(uri);
			expect(html).toContain("Authorization code will be sent to");
			expect(html).not.toContain("Unrecognised destination");
		}
	});

	it("escapes a hostile redirect host", async () => {
		const html = await dialog("https://x.example/cb?q=<script>alert(1)</script>");
		expect(html).not.toContain("<script>alert");
	});
});
