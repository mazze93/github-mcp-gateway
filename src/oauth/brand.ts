// The gateway's two human-facing pages (landing and consent) share one shell so
// they read as part of the mazzeleczzare.com workbench rather than a stock
// OAuth screen. Palette follows the site's "Kintsugi" tokens (teal, gold seam,
// coral on deep ink). Fonts are system stacks on purpose: a Worker has no
// asset host for the site's webfonts, and a third-party font CDN would put a
// network dependency, and a CSP hole, on the consent screen.

export const SITE_URL = "https://mazzeleczzare.com";
export const REPO_URL = "https://github.com/mazze93/github-mcp-gateway";

/**
 * Both pages are static markup with one inline stylesheet: no script, no
 * frames, no subresources. `form-action` is deliberately absent -- browsers
 * apply it to the redirect chain, and /authorize answers its POST with a 302
 * to github.com.
 */
export const PAGE_SECURITY_HEADERS: Record<string, string> = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};

export function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// A compass: ring, four-point needle, and a gold seam across it.
const MARK = `<svg class="mark" viewBox="0 0 64 64" role="img" aria-label="Compass mark" xmlns="http://www.w3.org/2000/svg">
<circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".55"/>
<path d="M32 6 L38 32 L32 58 L26 32 Z" fill="currentColor" opacity=".9"/>
<path d="M6 32 L32 26 L58 32 L32 38 Z" fill="none" stroke="currentColor" stroke-width="1.5"/>
<path d="M14 50 L50 14" stroke="var(--gold)" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const STYLE = `
  :root {
    color-scheme: dark;
    --ink: #0b1020; --panel: #121a30; --line: #26314f;
    --text: #e8ecf5; --muted: #98a3bd;
    --teal: #5ccfcf; --gold: #cda24e; --coral: #f07178;
    --serif: "Cormorant Garamond", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", "DM Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 24px;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--sans); color: var(--text); background: var(--ink);
    background-image: radial-gradient(ellipse at 50% -10%, #1b2750 0%, transparent 60%);
  }
  .card {
    position: relative; width: 100%; max-width: 480px; padding: 36px 32px 28px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  }
  .card::before {
    content: ""; position: absolute; left: 32px; right: 32px; top: -1px; height: 2px;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
  }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; color: var(--teal); }
  .mark { width: 44px; height: 44px; flex: none; }
  .eyebrow {
    margin: 0; font: 500 0.7rem/1.2 var(--mono); letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--gold);
  }
  h1 { margin: 2px 0 0; font: 600 1.7rem/1.1 var(--serif); color: var(--text); }
  p { color: var(--muted); font-size: 0.92rem; line-height: 1.6; margin: 0 0 14px; }
  .grant {
    margin: 20px 0; padding: 14px 16px; font-size: 0.88rem; line-height: 1.55; color: var(--text);
    background: var(--ink); border: 1px solid var(--line); border-left: 3px solid var(--teal);
    border-radius: 8px;
  }
  dl { margin: 18px 0; font-size: 0.85rem; }
  dt { font: 500 0.7rem/1 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-top: 12px; }
  dd { margin: 4px 0 0; font-family: var(--mono); color: var(--text); }
  button {
    width: 100%; margin-top: 6px; padding: 12px; border: 0; border-radius: 8px;
    font: 600 0.95rem var(--sans); cursor: pointer;
    background: var(--teal); color: var(--ink);
  }
  button:hover { filter: brightness(1.08); }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  a { color: var(--teal); text-underline-offset: 3px; }
  footer {
    margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line);
    display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 0.78rem; color: var(--muted);
  }
  @media (prefers-reduced-motion: no-preference) { button { transition: filter 0.15s; } }
`;

export interface PageOptions {
	/** Document title. Escaped here. */
	title: string;
	/** Small uppercase line above the heading. Escaped here. */
	eyebrow: string;
	/** The heading. Escaped here. */
	heading: string;
	/** Pre-escaped markup for the card body. Callers own escaping of anything untrusted. */
	body: string;
}

export function renderBrandedPage(options: PageOptions): string {
	const { title, eyebrow, heading, body } = options;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b1020">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
  <main class="card">
    <div class="brand">
      ${MARK}
      <div>
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(heading)}</h1>
      </div>
    </div>
    ${body}
    <footer>
      <a href="${SITE_URL}" rel="noopener">mazzeleczzare.com</a>
      <a href="${REPO_URL}" rel="noopener">Source</a>
      <span>A Mazze LeCzzare Frazer project</span>
    </footer>
  </main>
</body>
</html>`;
}

export function landingBody(): string {
	return `<p>A remote MCP server that gives Claude and other MCP clients authenticated
    access to GitHub through a GitHub App. Part of the workbench at
    <a href="${SITE_URL}" rel="noopener">mazzeleczzare.com</a>.</p>
    <dl>
      <dt>Streamable HTTP</dt><dd>/mcp</dd>
      <dt>Legacy SSE</dt><dd>/sse</dd>
    </dl>
    <p>Add this server's <code>/mcp</code> URL to an MCP client to connect. Access is
    limited to approved GitHub accounts; the client walks you through sign-in.</p>`;
}
