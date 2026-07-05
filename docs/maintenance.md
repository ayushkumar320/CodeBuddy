# Maintenance

How versioning and repo cleanup work for the next maintainer. Boring and
auditable on purpose — no hidden automation.

## Version: single source of truth

`package.json`'s `version` field is the **only** place the product version is
declared. Both runtime surfaces import it:

- `src/version.ts` — `export const VERSION = pkg.version` (bundler inlines the
  value at build time; no runtime file read).
- CLI `--version` → `src/cli/index.ts` uses `VERSION`.
- MCP handshake → `src/mcp/server.ts` uses `VERSION`.

To bump the version, edit `package.json` (or `npm version <x.y.z>`) — nothing
else. `src/version.test.ts` asserts `VERSION` equals `package.json` and is valid
semver, so a drift can't slip through CI.

## Branch cleanup (safe by default)

`npm run branches:prune` lists local branches already merged into `main`. It is
**dry-run by default** — it deletes nothing. It never touches `main`, the branch
you're currently on, or any remote branch.

```bash
npm run branches:prune                       # list merged local branches (dry run)
bash scripts/prune-merged-branches.sh --yes  # actually delete the listed branches
bash scripts/prune-merged-branches.sh --base release/x   # compare against another base
```

Remote branch deletion is intentionally out of scope — do that by hand with
`git push origin --delete <branch>` once you've confirmed the PR is merged.

## PostgreSQL recovery test

`npm run test:pg` runs the one DB-gated integration test end-to-end (brings
Postgres up via Docker, runs it, tears down). See
[live-test-checklist.md](live-test-checklist.md) step 11a.
