import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { renderApprovalDialog } from "../src/oauth/workers-oauth-utils";

const ctx: ExecutionContext = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: undefined,
} as unknown as ExecutionContext;

describe("landing page", () => {
	it("serves branded HTML at / instead of a bare 404", async () => {
		const res = await worker.fetch(new Request("https://gateway.example/"), env, ctx);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("mazzeleczzare.com");
		expect(html).toContain("A Mazze LeCzzare Frazer project");
		expect(html).toContain("/mcp");
		expect(html).toContain("/sse");
	});

	it("is script-free and locked down: no inline script, no framing", async () => {
		const res = await worker.fetch(new Request("https://gateway.example/"), env, ctx);
		const html = await res.text();
		expect(html.toLowerCase()).not.toContain("<script");
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toMatch(/script-src/);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("does not leak deployment identifiers", async () => {
		const res = await worker.fetch(new Request("https://gateway.example/"), env, ctx);
		const html = await res.text();
		expect(html).not.toMatch(/[0-9a-f]{32}/); // KV namespace ids and the like
		expect(html).not.toContain("workers.dev");
	});
});

describe("consent dialog branding", () => {
	const dialog = () =>
		renderApprovalDialog(new Request("https://gateway.example/authorize"), {
			client: { clientId: "c", redirectUris: ["https://example.com/cb"], clientName: "Normal Client" },
			csrfToken: "tok-123",
			server: { name: "GitHub MCP Gateway", description: "desc" },
			setCookie: "__Host-CSRF_TOKEN=tok-123; HttpOnly",
			state: {
				oauthReqInfo: { responseType: "code", clientId: "c", redirectUri: "https://example.com/cb", scope: [], state: "s" },
			},
		});

	it("carries the project footer and keeps the CSRF form intact", async () => {
		const res = dialog();
		const html = await res.text();
		expect(html).toContain("A Mazze LeCzzare Frazer project");
		expect(html).toContain('name="csrf_token" value="tok-123"');
		expect(html).toContain('action="/authorize"');
		expect(res.headers.get("Set-Cookie")).toBe("__Host-CSRF_TOKEN=tok-123; HttpOnly");
	});

	it("is not frameable, so the consent click cannot be hijacked", () => {
		expect(dialog().headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
	});

	it("never allows form-action, which browsers apply to the 302 to github.com", () => {
		expect(dialog().headers.get("Content-Security-Policy")).not.toContain("form-action");
	});
});
