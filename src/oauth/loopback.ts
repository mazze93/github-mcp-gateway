/**
 * Loopback redirect-URI normalisation.
 *
 * RFC 8252 §7.3 says native clients get an ephemeral loopback port, and that
 * servers MUST ignore the port when matching such redirect URIs. workers-oauth-
 * provider implements that rule, but its `isLoopbackUri()` recognises only the
 * literal IPs (`127.0.0.0/8`, `::1`) — never the hostname `localhost`. Any
 * `http://localhost:<port>/callback` therefore falls through to exact string
 * matching and fails against a registered `http://localhost/callback`.
 *
 * That is exactly what Claude Code sends: its Client ID Metadata Document
 * registers `http://localhost/callback` (portless) but the browser is sent to
 * `http://localhost:<ephemeral>/callback`. Every published version of the
 * library through 0.8.3 behaves this way, so upgrading does not help.
 *
 * We rewrite the hostname to `127.0.0.1` before the provider sees the request.
 * The library then treats it as loopback, applies the port-flexible rule, and
 * matches the registered `http://127.0.0.1/callback`. The client's callback
 * listener is bound to the loopback interface, so the browser still reaches it.
 *
 * Security notes:
 *   - Only the exact hostname `localhost` over `http:` is touched. `https:`
 *     and every other host are passed through untouched, so this cannot be
 *     used to redirect to an attacker-controlled origin.
 *   - `localhost` is rewritten to the loopback literal rather than the reverse,
 *     so we never widen matching to a name that could resolve off-loopback.
 *   - The rewrite is applied to /authorize AND /token. The authorization-code
 *     grant requires the two redirect_uri values to be identical, so
 *     normalising only one endpoint would break the token exchange.
 */

/** Hostname that the library fails to treat as loopback. */
const UNHANDLED_LOOPBACK_HOST = "localhost";

/** The loopback literal the library does recognise. */
const CANONICAL_LOOPBACK_HOST = "127.0.0.1";

/**
 * Rewrites `http://localhost[:port]/...` to `http://127.0.0.1[:port]/...`.
 * Returns the input unchanged if it is not such a URI.
 */
export function normalizeLoopbackRedirectUri(redirectUri: string): string {
	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		// Not an absolute URI — leave it alone and let the provider reject it.
		return redirectUri;
	}

	if (parsed.protocol !== "http:" || parsed.hostname !== UNHANDLED_LOOPBACK_HOST) {
		return redirectUri;
	}

	parsed.hostname = CANONICAL_LOOPBACK_HOST;
	return parsed.toString();
}

/** Rewrites the `redirect_uri` query parameter of an /authorize GET. */
function normalizeQuery(request: Request): Request {
	const url = new URL(request.url);
	const redirectUri = url.searchParams.get("redirect_uri");
	if (!redirectUri) return request;

	const normalized = normalizeLoopbackRedirectUri(redirectUri);
	if (normalized === redirectUri) return request;

	url.searchParams.set("redirect_uri", normalized);
	return new Request(url.toString(), request);
}

/** Rewrites the `redirect_uri` field of a form-encoded /token POST. */
async function normalizeFormBody(request: Request): Promise<Request> {
	const body = await request.clone().text();
	const params = new URLSearchParams(body);
	const redirectUri = params.get("redirect_uri");
	if (!redirectUri) return request;

	const normalized = normalizeLoopbackRedirectUri(redirectUri);
	if (normalized === redirectUri) return request;

	params.set("redirect_uri", normalized);
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: params.toString(),
	});
}

/**
 * Normalises loopback redirect URIs on the OAuth endpoints that carry one.
 * Every other request is returned untouched.
 */
export async function normalizeLoopbackRedirect(request: Request): Promise<Request> {
	const { pathname } = new URL(request.url);

	if (request.method === "GET" && pathname === "/authorize") {
		return normalizeQuery(request);
	}

	if (request.method === "POST" && pathname === "/token") {
		const contentType = request.headers.get("content-type") ?? "";
		if (contentType.includes("application/x-www-form-urlencoded")) {
			return normalizeFormBody(request);
		}
	}

	return request;
}
