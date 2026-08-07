/**
 * Defense-in-depth gate checked at the OAuth callback (see github-handler.ts):
 * even though only the account holder can complete the GitHub consent
 * screen for their own account, this stops the server issuing an MCP grant
 * to *any* GitHub identity that completes the flow.
 */
export function isLoginAllowed(login: string, allowedLoginsCsv: string): boolean {
	const allowedLogins = allowedLoginsCsv.split(",").map((s) => s.trim().toLowerCase());
	return allowedLogins.includes(login.toLowerCase());
}
