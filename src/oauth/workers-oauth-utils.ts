import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

const COOKIE_CSRF = "__Host-CSRF_TOKEN";
const COOKIE_SESSION = "__Host-CONSENTED_STATE";
const COOKIE_APPROVED = "__Host-APPROVED_CLIENTS";

const STATE_TTL_SECONDS = 600; // 10 minutes — one-time-use authorization state
const APPROVED_CLIENTS_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Thrown for any OAuth-flow-shaped failure (bad CSRF, expired state, missing
 * cookie, etc). Centralizing this means github-handler.ts can catch one type
 * and respond consistently instead of hand-rolling status codes per call site.
 */
export class OAuthError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "OAuthError";
	}

	toResponse(): Response {
		return new Response(this.message, { status: this.status });
	}
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
	}
	return undefined;
}

function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
	// __Host- prefix forces: Secure, no Domain attribute, Path=/.
	// That's the browser-enforced guarantee that this cookie can only have
	// been set by this exact origin — it cannot be injected by a sibling
	// subdomain, which matters because this server has no subdomain
	// boundary of its own to defend otherwise.
	return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function expireCookie(name: string): string {
	return `${name}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// HMAC signing (for the approved-clients cookie — the only cookie whose
// *content*, not just presence, must be tamper-evident)
// ---------------------------------------------------------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function toBase64Url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signData(payload: string, secret: string): Promise<string> {
	const key = await hmacKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return toBase64Url(sig);
}

async function verifyData(payload: string, signatureB64Url: string, secret: string): Promise<boolean> {
	const key = await hmacKey(secret);
	const padded = signatureB64Url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
	let raw: Uint8Array;
	try {
		const binary = atob(padded + pad);
		raw = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
	} catch {
		return false;
	}
	return crypto.subtle.verify("HMAC", key, raw, new TextEncoder().encode(payload));
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// CSRF protection for the POST /authorize consent form
// ---------------------------------------------------------------------------

export function generateCSRFProtection(): { token: string; setCookie: string } {
	const token = crypto.randomUUID();
	return { token, setCookie: hostCookie(COOKIE_CSRF, token, STATE_TTL_SECONDS) };
}

export function validateCSRFToken(formData: FormData, request: Request): void {
	const formToken = formData.get("csrf_token");
	const cookieToken = readCookie(request, COOKIE_CSRF);
	if (
		!formToken ||
		typeof formToken !== "string" ||
		!cookieToken ||
		formToken !== cookieToken
	) {
		throw new OAuthError(400, "CSRF token mismatch — please retry the authorization request.");
	}
}

// ---------------------------------------------------------------------------
// One-time-use OAuth state, stored server-side in KV
// ---------------------------------------------------------------------------

export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
): Promise<{ stateToken: string }> {
	const stateToken = crypto.randomUUID();
	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: STATE_TTL_SECONDS,
	});
	return { stateToken };
}

/**
 * Binds a state token to *this browser* via a hash, independent of the
 * plaintext token that travels through the redirect chain to GitHub and
 * back. Without this, an attacker who can get their own valid state token
 * embedded in a victim's browser (e.g. via a crafted link) could splice
 * their own GitHub authorization into the victim's session.
 */
export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
	const hash = await sha256Hex(stateToken);
	return { setCookie: hostCookie(COOKIE_SESSION, hash, STATE_TTL_SECONDS) };
}

export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string }> {
	const url = new URL(request.url);
	const stateToken = url.searchParams.get("state");
	if (!stateToken) throw new OAuthError(400, "Missing state parameter.");

	const sessionHash = readCookie(request, COOKIE_SESSION);
	if (!sessionHash) {
		throw new OAuthError(400, "Missing session binding cookie — restart the authorization flow.");
	}
	const expectedHash = await sha256Hex(stateToken);
	if (sessionHash !== expectedHash) {
		throw new OAuthError(400, "Session binding mismatch — this browser did not initiate this request.");
	}

	const raw = await kv.get(`oauth:state:${stateToken}`);
	if (!raw) throw new OAuthError(400, "Invalid or expired state — restart the authorization flow.");
	await kv.delete(`oauth:state:${stateToken}`); // one-time use

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = JSON.parse(raw);
	} catch {
		throw new OAuthError(500, "Corrupt state record.");
	}

	return { oauthReqInfo, clearCookie: expireCookie(COOKIE_SESSION) };
}

// ---------------------------------------------------------------------------
// Approved-client cookie — skips the consent screen on repeat connections
// from clients (e.g. Cowork) already approved within the last 30 days.
// ---------------------------------------------------------------------------

export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approved = await getApprovedClients(request, cookieSecret);
	return approved.includes(clientId);
}

async function getApprovedClients(request: Request, cookieSecret: string): Promise<string[]> {
	const raw = readCookie(request, COOKIE_APPROVED);
	if (!raw) return [];
	const dotIdx = raw.indexOf(".");
	if (dotIdx === -1) return [];
	const signature = raw.slice(0, dotIdx);
	const payloadB64 = raw.slice(dotIdx + 1);
	let payload: string;
	try {
		payload = atob(payloadB64);
	} catch {
		return [];
	}
	const valid = await verifyData(payload, signature, cookieSecret);
	if (!valid) return []; // tampered or signed with a rotated secret — treat as unapproved
	try {
		const parsed = JSON.parse(payload);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

export async function addApprovedClient(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<string> {
	const existing = await getApprovedClients(request, cookieSecret);
	const updated = Array.from(new Set([...existing, clientId]));
	const payload = JSON.stringify(updated);
	const signature = await signData(payload, cookieSecret);
	const value = `${signature}.${btoa(payload)}`;
	return hostCookie(COOKIE_APPROVED, value, APPROVED_CLIENTS_TTL_SECONDS);
}

// ---------------------------------------------------------------------------
// Consent screen
// ---------------------------------------------------------------------------

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export interface ApprovalDialogOptions {
	client: ClientInfo | null;
	csrfToken: string;
	server: { name: string; description: string; logo?: string };
	setCookie: string;
	state: { oauthReqInfo: AuthRequest };
}

export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
	const { client, csrfToken, server, setCookie, state } = options;
	const clientName = client?.clientName ? escapeHtml(client.clientName) : "An MCP client";
	const encodedState = btoa(JSON.stringify(state));

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(server.name)}</title>
<style>
  :root { color-scheme: dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0d1117; color: #e6edf3;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; padding: 24px;
  }
  .card {
    max-width: 420px; width: 100%; background: #161b22;
    border: 1px solid #30363d; border-radius: 12px; padding: 32px;
  }
  h1 { font-size: 1.1rem; margin: 0 0 8px; }
  p { color: #8b949e; font-size: 0.9rem; line-height: 1.5; }
  .grant {
    background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
    padding: 12px 16px; margin: 20px 0; font-size: 0.85rem; color: #e6edf3;
  }
  button {
    width: 100%; padding: 10px; border-radius: 8px; border: none;
    font-size: 0.95rem; font-weight: 600; cursor: pointer; margin-top: 8px;
  }
  .approve { background: #5CCFCF; color: #0d1117; }
  .deny { background: transparent; color: #8b949e; border: 1px solid #30363d; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(server.name)}</h1>
    <p>${escapeHtml(server.description)}</p>
    <div class="grant">
      <strong>${clientName}</strong> is requesting access to your GitHub repositories
      through this server. You'll choose which repositories on the next screen
      (GitHub's installation picker).
    </div>
    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="state" value="${escapeHtml(encodedState)}">
      <button type="submit" class="approve">Continue to GitHub</button>
    </form>
  </div>
</body>
</html>`;

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
		},
	});
}
