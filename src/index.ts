import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./oauth/github-handler";
import { GitHubMcpAgent } from "./github-mcp-agent";
import { guardRegistration } from "./oauth/register-guard";

export { GitHubMcpAgent };

// workers-oauth-provider 1.x binds every token's audience to ONE canonical
// resource (RFC 9728 `resource`), fixed at construction. 0.x derived it per
// request, and advertised a per-path resource (`<origin>/mcp`).
//
// The canonical resource is the bare ORIGIN, not `<origin>/mcp`: 1.x requires
// every apiHandlers key to be the resource's path or a path-boundary
// descendant of it, and `/mcp` + `/sse` are siblings at root (they must stay
// there -- workers-oauth-provider #108/#133). A bare origin covers every path.
// MCP SDK clients (Claude Code included) read `resource` from the
// protected-resource metadata and send it back as the `resource` parameter,
// so they follow this without configuration. A 0.x grant whose audience was
// `<origin>/mcp` fails its next refresh with `invalid_grant`, and conformant
// clients answer that by re-authorizing once.
//
// The origin comes from the request rather than a hardcoded URL so the same
// build serves workers.dev, a custom domain, `wrangler dev` (loopback http is
// allowed) and a fork's deployment. request.url's host is one Cloudflare
// already routed to THIS Worker, so a caller cannot pick an arbitrary
// audience; tokens minted for one origin are refused on another, which is
// the point of audience binding.
function createProvider(origin: string): OAuthProvider {
	return new OAuthProvider({
		resourceMetadata: {
			resource: origin,
			authorization_servers: [origin],
		},
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
}

// One provider per origin, built on first use. Construction validates the
// whole configuration, so a bad option fails the first request on that
// origin loudly rather than half-working.
const providers = new Map<string, OAuthProvider>();

function providerFor(request: Request): OAuthProvider {
	const { origin } = new URL(request.url);
	let provider = providers.get(origin);
	if (!provider) {
		provider = createProvider(origin);
		providers.set(origin, provider);
	}
	return provider;
}

// Let the provider validate registered redirect URIs without rewriting hosts.
// Current versions support localhost, IPv4 loopback and IPv6 loopback directly.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const guarded = await guardRegistration(request);
		if (guarded instanceof Response) return guarded;
		return providerFor(guarded).fetch(guarded, env, ctx);
	},
};
