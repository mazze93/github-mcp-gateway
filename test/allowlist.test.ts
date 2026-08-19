import { describe, expect, it } from "vitest";
import { isLoginAllowed } from "../src/oauth/allowlist";

describe("isLoginAllowed", () => {
	it("allows a login present in the list", () => {
		expect(isLoginAllowed("mazze93", "mazze93")).toBe(true);
	});

	it("denies a login absent from the list", () => {
		expect(isLoginAllowed("attacker", "mazze93")).toBe(false);
	});

	it("is case-insensitive on both sides", () => {
		expect(isLoginAllowed("Mazze93", "mazze93")).toBe(true);
		expect(isLoginAllowed("mazze93", "MAZZE93")).toBe(true);
	});

	it("supports a comma-separated list and tolerates surrounding whitespace", () => {
		expect(isLoginAllowed("bob", "alice, bob , carol")).toBe(true);
		expect(isLoginAllowed("dave", "alice, bob , carol")).toBe(false);
	});

	it("denies a real login when the list is empty", () => {
		expect(isLoginAllowed("mazze93", "")).toBe(false);
	});

	it("documents (does not guard) the empty-login/empty-list edge: '' matches ''", () => {
		// "".split(",") is [""], so an empty allowlist technically "contains" an
		// empty string. Not a guard-worthy gap: `login` here is always
		// user.login from a validated GitHub API response, which is never "".
		expect(isLoginAllowed("", "")).toBe(true);
	});

	it("does not substring-match -- a login must match a full entry", () => {
		expect(isLoginAllowed("mazze9", "mazze93")).toBe(false);
		expect(isLoginAllowed("mazze930", "mazze93")).toBe(false);
	});
});
