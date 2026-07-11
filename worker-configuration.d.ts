import type { GitHubMcpAgent } from "./src/github-mcp-agent";

// This file has a top-level import, which makes it an ES module — so the
// augmentation below must go through `declare global` to remain visible
// as an ambient type across the rest of the project. Bindings/secrets are
// declared on `Cloudflare.Env` specifically (not the bare global `Env`)
// because that's what `import { env } from "cloudflare:workers"` reads its
// type from — this matches what `wrangler types` generates.
declare global {
	namespace Cloudflare {
		interface Env {
			// Secrets (wrangler secret put)
			GITHUB_APP_CLIENT_ID: string;
			GITHUB_APP_CLIENT_SECRET: string;
			COOKIE_ENCRYPTION_KEY: string;

			// Plain var — comma-separated GitHub logins permitted to use this server
			ALLOWED_GITHUB_LOGINS: string;

			// Bindings
			OAUTH_KV: KVNamespace;
			MCP_OBJECT: DurableObjectNamespace<GitHubMcpAgent>;
		}
	}
	interface Env extends Cloudflare.Env {}
}

export {};
