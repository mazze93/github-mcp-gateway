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
	// Client ID Metadata Documents. Defaults to FALSE in the library, which is
	// the trap: wrangler.jsonc has carried `global_fetch_strictly_public` --
	// added specifically to enable CIMD -- since long before this option was
	// set, so the flag was doing nothing at all.
	//
	// Without this, a URL-formatted client_id does NOT resolve by fetching its
	// metadata document. It silently falls back to a plain KV lookup:
	//
	//   if (isClientMetadataUrl(clientId)) {
	//     if (!options.clientIdMetadataDocumentEnabled)
	//       return env.OAUTH_KV.get(`client:${clientId}`);   // <- no fetch
	//     return await fetchClientMetadataDocument(clientId);
	//   }
	//
	// Claude Code authenticates with a URL client_id
	// (https://claude.ai/oauth/claude-code-client-metadata), so it worked only
	// while a matching `client:` record happened to sit in KV, and returned
	// "invalid_request: Invalid client_id" once that record was gone. That
	// non-determinism is what surfaced this: deploy.yml's smoke test flipped
	// from 200 to 400 across two deploys of identical code.
	//
	// Requires global_fetch_strictly_public (see wrangler.jsonc). With both
	// set, the discovery document's
	// client_id_metadata_document_supported: true is finally accurate.
	clientIdMetadataDocumentEnabled: true,
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
