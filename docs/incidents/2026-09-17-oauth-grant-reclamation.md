# Incident — irreversible reclamation of a live OAuth grant based on a liveness proxy

- **Date:** 2026-09-17
- **Service:** `github-mcp-gateway` (HIGH posture)
- **Store:** `OAUTH_KV`, namespace `0773ec3dd785418c984559f47d1623e9`
- **Impact:** 4 OAuth grant keys permanently deleted; at least one belonged to a live client.
  Encrypted refresh tokens were not captured beforehand and cannot be reconstructed.
- **Status:** Cause understood and confirmed. One downstream effect remains **unconfirmed**
  (see §4). Guards proposed, **not yet implemented**.

## 1. What happened

0. **(2026-09-13)** A prior session cut v1.1.0, resolved an RFC 8707 resource-path mismatch, and
   recorded in memory that it had **"flagged 5 stale KV grants for cleanup."** This was an
   *observation*, produced by the same 1-hour-token inference described in §2. The note carried the
   conclusion but not the reasoning, and no liveness context.
1. **(2026-09-17, 07:50)** A session opened with no task. It found no journal, checkpoint or handoff
   file in the repo, a clean tree, no open PRs and no open issues — so it went to memory for the
   trail and surfaced the 09-13 note. The "5 stale grants" line was read as a **sanctioned work
   item**, not as a claim to re-derive.
2. A routine maintenance session set out to "clean up stale OAuth grants" in `OAUTH_KV`.
3. It enumerated all 44 keys: 33 `client:`, 8 `grant:`, 2 `token:`, 1 `github:`.
4. It classified a grant as a cleanup candidate on **four converging signals**, not one: no
   matching `token:` key; no KV TTL; age 37–54 days; and `resource=/` rather than `/mcp`, marking
   it as predating the 2026-09-13 RFC 8707 fix. It also did substantial diligence first — read the
   library's own `revokeGrant` to learn the correct deletion shape, confirmed
   `DEFAULT_ACCESS_TOKEN_TTL = 3600` was not overridden, consulted an advisor, and stated
   explicitly in its own review table that *"'idle' = no tool call in the last hour, not
   'abandoned.'"* This was not a careless pass.
5. Of 6 tokenless grants it split off a "Tier A" of 4, held back a "Tier B" of 2 recent ones, and
   presented the split for confirmation. One Tier A entry —
   `grant:mazze93:mHKjQbvTaNYfYqfr` — belonged to DCR client `UnzCBxgStfhy5ryQ`: a live
   burst-mode harness registered as "Claude Code (github-mcp-gateway)" on
   `http://localhost:3118/callback`.

   **That friendly name was NOT visible at decision time.** It was recovered afterwards, during
   post-incident analysis, by reading the `client:` record. What the confirmation table actually
   showed in the client column was the raw identifier **`DCR UnzCBx…`** — while every other row
   resolved to a legible name (`claude-code`, `mcp-oauth`). The signal that was genuinely present,
   and genuinely missed, is therefore narrower and more interesting than "the name was printed":
   **the one row that mattered was the only row whose client did not resolve to a friendly name,
   and that anomaly was rendered distinctly and not investigated.**
6. The operator confirmed Tier A. `wrangler kv bulk delete delete_tierA.json --remote --force`
   ran. 44 → 40 keys. Irreversible.
7. A concurrent Claude Code session in the same terminal window ended at that moment.

## 2. Why the classification was wrong

**Four signals, one blind spot.** The four criteria in step 4 look like convergent evidence and
feel like corroboration, but **every one of them measures age, not liveness**: a missing `token:`
key means no call in an hour; no TTL means the grant was written before `refreshTokenTTL` would
have applied (and it never was — see §3); 37–54 days is age; and `resource=/` means the grant
predates a fix, which again is age. A long-lived burst harness that authorized in July and
refreshes rarely scores "stale" on all four simultaneously. **Convergent evidence that shares a
common blind spot is not corroboration — it is the same measurement taken four times.**

**The staleness test could not distinguish "idle but live" from "abandoned."**

`DEFAULT_ACCESS_TOKEN_TTL = 3600` (`oauth-provider.js:3065` (workers-oauth-provider 0.10.3)),
and the app never overrides `accessTokenTTL` — verified: no occurrence in `src/`. Access tokens
are therefore 1-hour objects, so **"no `token:` key" means only "no tool call in the last hour."**
A burst harness between bursts is indistinguishable in KV from a dead session. The heuristic
mapped *quiet* onto *garbage*.

## 3. Root cause — corrected from the first analysis

The initial write-up attributed the missing TTLs to the grants being old: *"they predate
`saveGrantWithTTL`, so they never self-expire."* **This is wrong, and the correction matters
because it changes the fix.**

`saveGrantWithTTL` (`oauth-provider.js:2763`) runs for *every* grant, but:

```js
async saveGrantWithTTL(env, grantKey, grantData, now) {
  const minExpiration = now + KV_MIN_EXPIRATION_TTL_SECONDS + KV_EXPIRATION_CLAMP_MARGIN_SECONDS;
  const kvOptions = grantData.expiresAt !== void 0
    ? { expiration: Math.max(grantData.expiresAt, minExpiration) } : {};
  await env.OAUTH_KV.put(grantKey, JSON.stringify(grantData), kvOptions);
  …
}
```

It sets an expiration only when `grantData.expiresAt` is defined. That is set at line 1964, from `this.options.refreshTokenTTL` (line 1912), which has no default:

```js
const expiresAt = refreshTokenTTL !== void 0 ? now + refreshTokenTTL : void 0;
```

`refreshTokenTTL` comes from `this.options.refreshTokenTTL`, which **has no default**. And
`src/index.ts:8–17` does not set it:

```ts
const provider = new OAuthProvider({
  apiHandlers: { "/mcp": …, "/sse": … },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as never,
});
```

**Therefore no grant this service has ever issued expires, and none ever will under the current
configuration.** The immortal-grant population is not a legacy artifact — it regenerates on every
new authorization. A one-time backfill would leave the class fully open.

### Root-cause chain (corrected)

0. **Observation-to-directive drift across a session boundary.** "Stale" was an *inference* on
   09-13 and a *task* on 09-17. Memory preserved the conclusion and discarded the hedge, so the
   executing session inherited a classification it never re-derived and could not see the basis of.
   The unsafe action was effectively pre-authorized four days earlier by a note that was never
   written as an authorization. **This is where the incident actually starts** — every later control
   was operating on a premise already treated as settled.
1. `refreshTokenTTL` unset ⇒ every grant is written with no KV expiration ⇒ grants accumulate
   indefinitely ⇒ the store invites manual pruning, which is the one unsafe operation.
2. Staleness judged by an activity proxy (1-hour access-token presence) that cannot express
   liveness.
3. The reclamation action is irreversible *and* actively hostile: revoking a grant does not
   passively free space, it breaks the live client holding it on its next call.
4. Human confirmation ratified the *classification*, not ground truth. The review table showed
   age, TTL, resource path and "idle" — not "this client is currently running as a process." The
   decision-relevant fact was derivable and simply not derived. Note in fairness to the operator:
   the table gave them no way to see it. The only trace was an unresolved DCR id in a column where
   every other row read as a product name.
4b. **The blast-radius assessment was wrong for the client that mattered.** The session reasoned,
   explicitly and in writing, that *"recovery from a wrong delete is just a reconnect."* That holds
   for an interactive client, which is what every other grant was. It does not hold for an
   unattended burst harness mid-run: re-auth is not automatic, and work since the last checkpoint
   can be lost. The risk was assessed against the majority case and applied to the exception.
5. Structurally, a routine maintenance session held unsupervised `--force` delete authority over
   a shared auth store that sibling live agents depend on: a self-inflicted DoS surface with no
   interlock.

## 4. Confirmed vs. unconfirmed

**Confirmed:**
- 4 `grant:` keys deleted; one belonged to a live harness client; not recoverable.
- The deleting session **verified its own MCP connection afterwards** (a `github_get_repo` call
  succeeded) and reported the cleanup as clean. That verification was sound but tested the wrong
  subject — its own grant was deliberately retained. No check covered the sibling.
- Only `grant:` keys were deleted. `client:UnzCBxgStfhy5ryQ` and `github:tokens:mazze93` were
  untouched, so the client registration and the GitHub login survive; what was destroyed is the
  authorization binding between them.
- No filesystem, git, or Stratum data was lost — `OAUTH_KV` held no such keys and git
  checkpoints live on disk.
- `DEFAULT_ACCESS_TOKEN_TTL = 3600`, not overridden.
- `refreshTokenTTL` unset ⇒ grants never expire (§3).
- `src/tools/helpers.ts:32` converts `ReauthorizationRequiredError` into a returned failure,
  **not** a throw:
  ```ts
  if (error instanceof ReauthorizationRequiredError) {
    return fail(error.message);
  }
  ```

**Unconfirmed — do not state as fact:** that the KV delete *caused* the concurrent session to
terminate. The timing is exact, but no crash report or daemon-log exit was found at that
timestamp, and the documented code path above predicts a clean error result, not process death.
**Leading hypothesis, mechanism unverified.**

### Repro to settle it

With a disposable burst client authorized under a test grant, delete that grant via KV and observe
whether the client (a) receives an `isError` re-auth result and continues, or (b) terminates. That
single test decides whether the session death is a `github-mcp-gateway` defect, a Claude Code MCP
client defect, or environment-specific — and therefore whether G8 is the real fix or a nicety.

## 5. Vulnerability class

> **Destructive reclamation of shared session/authorization state driven by a liveness proxy that
> cannot distinguish idle-but-live from abandoned, where the reclamation is irreversible and
> disrupts live dependents.**

Same shape as a GC freeing a still-referenced object, or an OOM reaper killing a sleeping process.

**Preconditions:** (a) shared mutable auth/session state; (b) a cleanup actor with delete
authority; (c) staleness judged by an activity proxy; (d) no liveness interlock; (e) irreversible
action.

## 6. Guards

**Preventive**
- **G1 — Set `refreshTokenTTL` so grants self-expire. This is the primary fix and it is a config
  change, not a backfill.** Expiry is self-correcting: a live client refreshes and survives, a dead
  one lapses, and no human ever needs to delete a grant. Backfilling `expiration` on the existing
  no-TTL grants is worth doing *as well*, but on its own it does not close the class (§3).
- **G2 — Absolute age floor.** Never reclaim a grant younger than a deliberately chosen policy
  floor. *Note: the original write-up floored this at "the refresh-token TTL (6 months)" — there is
  no such TTL in this codebase, since `refreshTokenTTL` is unset. The floor must be a policy number,
  not a read of config.* The 4 deleted grants were 37–54 days old.
- **G3 — Positive liveness check, not a proxy.** Before any grant mutation, cross-reference the
  grant's client against real liveness: running processes, active DO sessions, recent auth-server
  logs. No live match required before proceeding.

**Detective / containment**
- **G4 — Soft-delete.** Copy candidates to a `revoked:` prefix with a 30-day TTL before removing
  the live key, so a mistake has a recovery window.
- **G5 — No `--force` on auth-store mutation from a session agent.** Dry-run + diff is the default.

**Structural**
- **G6 — Separate capability.** Routine sessions must not hold write/delete on the shared auth
  store; mutation requires a distinct, explicitly-invoked, human-in-the-loop tool.
- **G7 — Confirmation dialogs must carry liveness as a mandatory field.** "Client last seen /
  running as PID X" must be present, and a grant whose client liveness is *unknown* is **blocked,
  not confirmable**.

**Cross-session**
- **G9 — A recorded observation is not a work item.** Memory and handoff notes must keep the
  inference visible: not "5 stale grants flagged for cleanup" but "5 grants with no `token:` key —
  *staleness inferred from 1h access-token TTL, liveness not checked*." Any note that licenses a
  destructive action must carry the basis of its classification, and a session picking up such an
  item must re-derive it before acting rather than treating the prior session's conclusion as
  settled. Cheap rule of thumb: if a note would justify an irreversible action on its own, it needs
  its evidence attached or it needs a question mark.

**Harness-side (blast radius)**
- **G8 — Flush on auth failure.** A burst client should treat `ReauthorizationRequiredError` as a
  checkpoint trigger (git commit + `stratum decide` flush) before re-auth, and degrade to re-auth
  rather than terminate, so an auth yank never costs the tail. *Gated on the §4 repro.*

## 7. Follow-ups

- [ ] Run the §4 repro to settle the causation question.
- [ ] G1: set `refreshTokenTTL` in `src/index.ts` (decide the value deliberately — it is the
      maximum lifetime of an unrefreshed authorization).
- [ ] G1b: backfill `expiration` on the 4 remaining no-TTL grants.
- [ ] G4/G5/G7: encode in whatever runbook or tool performs auth-store maintenance.
- [ ] Re-authorize the broken client(s) when next used — expected symptom is a re-auth prompt.

## 8. Verification provenance — two clones exist

**This matters for anyone re-checking the above.** There are two clones of this repo on this
machine, under two different home directories:

| Clone | State | Library |
|---|---|---|
| `/Users/mazze/Code/systems/github-mcp-gateway` | **canonical** — `main` at v1.1.0 (PRs #52–54), clean | `@cloudflare/workers-oauth-provider ^0.10.3` |
| `/Users/daedalus/Projects/tools/github-mcp-gateway` | **stale** — ~50 PRs behind, dependency bump left staged | `^0.2.2` |

Both point at `origin https://github.com/mazze93/github-mcp-gateway.git`.

The first pass of this analysis was performed against the **stale** clone and quoted line numbers
from library 0.2.2. **Every finding was then re-verified against the canonical clone on 0.10.3 and
all of them hold** — `refreshTokenTTL` is set nowhere in `src/`, `DEFAULT_ACCESS_TOKEN_TTL` is
still 3600 (`:3065`) and still only a fallback (`:2155`), `saveGrantWithTTL` still writes empty KV
options when `expiresAt` is undefined (`:2763`), and `helpers.ts:32–34` still returns `fail(...)`
rather than throwing. Only the line numbers changed; the conclusions did not. Line references in
this document are to **0.10.3**.

0.10.3 additionally clamps grant expirations to a floor of `KV_MIN_EXPIRATION_TTL_SECONDS` (60) +
`KV_EXPIRATION_CLAMP_MARGIN_SECONDS` (5) — relevant only in that a very small `refreshTokenTTL`
cannot be used to expire grants aggressively.

## 9. Other observations found while verifying

- `package.json` / `package-lock.json` are **staged but uncommitted in the stale clone** (a workerd
  bump, `1.20260730.1` → `1.20260908.1`). Left untouched. Given that clone is ~50 PRs behind
  canonical, the bump is probably better discarded than committed — but that is a judgement call
  for a human, not something this write-up should decide.
- The per-project memory directory keyed `-Users-mazze-Code-systems-github-mcp-gateway` is
  **correct, not stale** — it matches the canonical clone's real path. (An earlier draft of this
  document called it rot, on the mistaken assumption that `/Users/mazze` did not exist.) The
  consequence to be aware of is the reverse: memory written under that slug will **not** auto-load
  for a session started from `~/Projects/tools/github-mcp-gateway`, so the two homes have
  divergent memory as well as divergent code. That is a consolidation gap, tracked separately
  under the account-consolidation work.
