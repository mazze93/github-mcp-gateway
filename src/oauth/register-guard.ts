// POST /register is unauthenticated by design (RFC 7591, and Claude.ai needs
// it). The provider stores whatever it is sent, so without limits anyone can
// fill the OAUTH_KV namespace with arbitrarily large client records. These
// caps are far above any legitimate client's metadata. Rate limiting is not
// possible here: Cloudflare rate-limiting rules need a zone, and workers.dev
// has none.

export const MAX_REGISTRATION_BYTES = 16 * 1024;
export const MAX_CLIENT_NAME_LENGTH = 100;

function reject(status: number, description: string): Response {
	return new Response(JSON.stringify({ error: "invalid_client_metadata", error_description: description }), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

/** Reads at most `max` bytes. Returns null when the body is larger. */
async function readCapped(request: Request, max: number): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Returns a Response to send back (rejected), or the Request to hand to the
 * provider (body re-materialised, since reading consumed it). Anything that
 * is not a registration passes through untouched, and malformed JSON is left
 * for the provider to reject in its own words.
 */
export async function guardRegistration(request: Request): Promise<Request | Response> {
	if (request.method !== "POST" || new URL(request.url).pathname !== "/register") return request;

	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_REGISTRATION_BYTES) {
		return reject(413, `Registration body exceeds ${MAX_REGISTRATION_BYTES} bytes`);
	}
	const text = await readCapped(request, MAX_REGISTRATION_BYTES);
	if (text === null) return reject(413, `Registration body exceeds ${MAX_REGISTRATION_BYTES} bytes`);

	try {
		const metadata: unknown = JSON.parse(text);
		const name = (metadata as { client_name?: unknown } | null)?.client_name;
		if (typeof name === "string" && name.length > MAX_CLIENT_NAME_LENGTH) {
			return reject(400, `client_name exceeds ${MAX_CLIENT_NAME_LENGTH} characters`);
		}
	} catch {
		// Not JSON: the provider produces the canonical error.
	}
	return new Request(request.url, { method: request.method, headers: request.headers, body: text });
}
