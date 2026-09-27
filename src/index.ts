import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./oauth/github-handler";
import { GitHubMcpAgent } from "./github-mcp-agent";
import { normalizeLoopbackRedirect } from "./oauth/loopback";

export { GitHubMcpAgent };

// refreshTokenTTL has no default in workers-oauth-provider — leaving it unset
// means grants never expire and accumulate in OAUTH_KV forever, which is what
// made manual KV pruning look necessary and caused the 2026-09-17 grant
// reclamation incident (docs/incidents/2026-09-17-oauth-grant-reclamation.md,
// guard G1). 90 days is a deliberate policy choice, not a read of some
// existing config: it's the longest an authorized client can go without a
// refresh call before its grant self-expires.
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;

const provider = new OAuthProvider({
	apiHandlers: {
		"/mcp": GitHubMcpAgent.serve("/mcp"),
		"/sse": GitHubMcpAgent.serveSSE("/sse"),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register", // required for Cowork/Claude.ai Dynamic Client Registration
	defaultHandler: GitHubHandler as never,
	refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
});

// The provider is wrapped rather than exported directly so loopback redirect
// URIs can be normalised before it validates them — see ./oauth/loopback.ts.
export default {
	fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
		return normalizeLoopbackRedirect(request).then((normalized) =>
			provider.fetch(normalized, env, ctx),
		);
	},
};
