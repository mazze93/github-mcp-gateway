# AGENTS.md

**This file is intentionally a pointer, not a copy.**

Read [`CLAUDE.md`](./CLAUDE.md) — it is the single source of truth for
how to work in this repository, and it applies to every coding agent
regardless of vendor. Commands, architecture, the tool-adding pattern,
constraints, and recovery steps all live there.

## Why this is a pointer

`AGENTS.md` previously duplicated `CLAUDE.md` with the client names
find-replaced. The two then drifted, as duplicated instructions always
do: the copy went on telling agents that `npm run deploy` was the deploy
path months after CI took that over, described a repo with no test
suite, and referred to a product called "Codex.ai/Cowork" that does not
exist.

An agent reading stale instructions confidently does the wrong thing.
One file that is right beats two that disagree.

## If you maintain another agent's config

Point it at `CLAUDE.md` rather than forking a copy here.
