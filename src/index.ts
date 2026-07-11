import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./oauth/github-handler";
import { GitHubMcpAgent } from "./github-mcp-agent";

export { GitHubMcpAgent };

export default new OAuthProvider({
	apiHandlers: {
		"/mcp": GitHubMcpAgent.serve("/mcp"),
		"/sse": GitHubMcpAgent.serveSSE("/sse"),
	},
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register", // required for Cowork/Claude.ai Dynamic Client Registration
	defaultHandler: GitHubHandler as never,
});
