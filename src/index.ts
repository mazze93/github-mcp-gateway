import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./oauth/github-handler";
import { GitHubMcpAgent } from "./github-mcp-agent";
import { normalizeLoopbackRedirect } from "./oauth/loopback";

export { GitHubMcpAgent };

const provider = new OAuthProvider({
	apiHandlers: {
		"/mcp": GitHubMcpAgent.serve("/mcp"),
		"/sse": GitHubMcpAgent.serveSSE("/sse"),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register", // required for Cowork/Claude.ai Dynamic Client Registration
	defaultHandler: GitHubHandler as never,
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
