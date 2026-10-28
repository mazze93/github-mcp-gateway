import { describe, expect, it } from "vitest";
import { guardRegistration, MAX_CLIENT_NAME_LENGTH, MAX_REGISTRATION_BYTES } from "../src/oauth/register-guard";

const post = (body: string, path = "/register", headers: Record<string, string> = {}) =>
	new Request(`https://gateway.example${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});

describe("guardRegistration", () => {
	it("passes non-registration requests through untouched", async () => {
		const req = post("x".repeat(MAX_REGISTRATION_BYTES * 2), "/token");
		expect(await guardRegistration(req)).toBe(req);
		const get = new Request("https://gateway.example/register");
		expect(await guardRegistration(get)).toBe(get);
	});

	it("accepts normal metadata and hands the provider a readable body", async () => {
		const body = JSON.stringify({
			client_name: "Claude Code",
			redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
		});
		const out = await guardRegistration(post(body));
		expect(out).toBeInstanceOf(Request);
		expect(await (out as Request).text()).toBe(body);
	});

	it("accepts a client_name at the limit and rejects one past it", async () => {
		const at = await guardRegistration(post(JSON.stringify({ client_name: "a".repeat(MAX_CLIENT_NAME_LENGTH) })));
		expect(at).toBeInstanceOf(Request);
		const over = await guardRegistration(
			post(JSON.stringify({ client_name: "a".repeat(MAX_CLIENT_NAME_LENGTH + 1) })),
		);
		expect(over).toBeInstanceOf(Response);
		expect((over as Response).status).toBe(400);
		expect(await (over as Response).json()).toMatchObject({ error: "invalid_client_metadata" });
	});

	it("rejects an oversized body by declared length with 413", async () => {
		const out = await guardRegistration(
			post("{}", "/register", { "content-length": String(MAX_REGISTRATION_BYTES + 1) }),
		);
		expect((out as Response).status).toBe(413);
	});

	it("rejects an oversized body even when no length is declared (streamed)", async () => {
		const chunk = new TextEncoder().encode("a".repeat(4096));
		const stream = new ReadableStream({
			pull(controller) {
				controller.enqueue(chunk);
			},
		});
		const req = new Request("https://gateway.example/register", {
			method: "POST",
			body: stream,
			// @ts-expect-error duplex is required for streamed bodies in workerd
			duplex: "half",
		});
		const out = await guardRegistration(req);
		expect((out as Response).status).toBe(413);
	});

	it("leaves malformed JSON for the provider to reject in its own words", async () => {
		const out = await guardRegistration(post("{not json"));
		expect(out).toBeInstanceOf(Request);
	});
});
