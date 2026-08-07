import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Secrets that only exist via `wrangler secret put` in prod / in
				// .dev.vars locally (never committed, see .dev.vars.example).
				// Tests need *a* value, not the real one -- these are fixtures.
				bindings: {
					GITHUB_APP_CLIENT_ID: "test-client-id",
					GITHUB_APP_CLIENT_SECRET: "test-client-secret",
					COOKIE_ENCRYPTION_KEY: "test-cookie-encryption-key-not-real",
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
