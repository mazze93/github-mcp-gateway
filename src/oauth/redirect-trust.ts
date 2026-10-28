// Open dynamic client registration means anyone can register a client with any
// `client_name` and any https redirect URI, then send the owner a crafted
// /authorize link. The allowlist cannot help: the victim IS the allowed user.
// The consent screen is the only place a human can catch it, so it must show
// WHERE the authorization code goes, not just what the client calls itself.
// This classifies that destination. It only informs the screen; it never blocks.

export type RedirectTrust =
	| { kind: "loopback"; host: string }
	| { kind: "known"; host: string }
	| { kind: "unverified"; host: string }
	| { kind: "invalid"; host: string };

/** First-party MCP client callbacks. Exact host or a subdomain of it. */
const KNOWN_HOSTS = ["claude.ai", "claude.com"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function classifyRedirect(redirectUri: string): RedirectTrust {
	let url: URL;
	try {
		url = new URL(redirectUri);
	} catch {
		return { kind: "invalid", host: "(unreadable address)" };
	}
	// `hostname` is what the browser will actually connect to: it is not fooled
	// by `https://claude.ai@evil.example/` or `https://claude.ai.evil.example/`.
	const hostname = url.hostname.toLowerCase();
	if (LOOPBACK_HOSTS.has(hostname)) return { kind: "loopback", host: url.host };
	const known = KNOWN_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
	if (known && url.protocol === "https:") return { kind: "known", host: url.host };
	return { kind: "unverified", host: url.host };
}
