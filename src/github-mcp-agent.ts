import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { registerContentTools } from "./tools/contents";
import { registerIssueTools } from "./tools/issues";
import { registerPullRequestTools } from "./tools/pulls";
import { registerRepoTools } from "./tools/repos";
import { registerSearchTools } from "./tools/search";
import type { Props } from "./types";

export class GitHubMcpAgent extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "github-mcp-gateway",
		version: "1.0.0",
	});

	async init(): Promise<void> {
		// `this.props` is populated from the OAuth grant before init() runs —
		// see OAuthProvider's completeAuthorization() in oauth/github-handler.ts.
		// It will not be undefined for any authenticated session reaching here,
		// but the type is optional upstream, so guard defensively.
		if (!this.props) return;

		registerRepoTools(this.server, this.env, this.props);
		registerIssueTools(this.server, this.env, this.props);
		registerPullRequestTools(this.server, this.env, this.props);
		registerContentTools(this.server, this.env, this.props);
		registerSearchTools(this.server, this.env, this.props);
	}
}
