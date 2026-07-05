# CodeBuddy — Live test checklist (before pushing v2.0)

A hands-on pass to confirm CodeBuddy works as a real user would experience it —
testing the **built, packed artifact**, not the source. Work top to bottom; each
step lists the command and what "pass" looks like. Most of it needs no database.

> Legend: **[file]** = no database needed · **[db]** = needs Postgres · **[mcp]**
> = tested inside Claude Code/Codex.

---

## 0. Automated gate (must be green first)

```bash
npm run typecheck        # ✅ no errors
npm run lint             # ✅ no errors
npm test                 # ✅ all pass (1 Postgres integration test may skip)
npm run build            # ✅ builds dist/
npm audit --omit=dev     # ✅ 0 vulnerabilities
npm pack --dry-run       # ✅ lists dist/, migrations, README, examples; version 2.0.0
```

## 1. Install the real artifact

Test what npm ships, not `tsx` on source.

```bash
npm run build
npm pack                                        # → ayushkumar320-codebuddy-2.0.0.tgz
npm install -g ./ayushkumar320-codebuddy-2.0.0.tgz
codebuddy --version                             # PASS: prints 2.0.0
codebuddy --help                                # PASS: lists index, context, symbols, savings, suggest, memory, rules, hooks
```
Cleanup later: `npm rm -g @ayushkumar320/codebuddy`.

## 2. Scaffold a real project [file]

```bash
cd ~/Projects/<some-ts-or-js-repo>
codebuddy init --non-interactive                # PASS: creates .codebuddy/ (config, memory, plans, policies.yaml)
ls .codebuddy
```

## 3. Background indexing [file]

```bash
codebuddy index                                 # PASS: "N indexed (+N ~0 =0 -0) in Xms"
codebuddy index                                 # PASS: all "=N" (incremental, unchanged)
echo "// touch" >> src/<somefile>.ts
codebuddy index                                 # PASS: shows "~1" changed
# optional: codebuddy watch  (edit a file in another terminal → re-index; Ctrl+C)
```

## 4. Token savings [file]

```bash
codebuddy savings                               # PASS: "saved N tokens (X% smaller)" + project summary
codebuddy savings --json                        # PASS: available:true, baselineTokens>returnedTokens, savedTokens≥0
```

## 5. Context preview [file]

```bash
codebuddy context bootstrap                     # PASS: project, plan, policy, incidents, architecture, token line
codebuddy context preview --paths src/<f>.ts    # PASS: targets + policy/risk/neighbours
codebuddy context explain --paths src/<f>.ts    # PASS: "why included" lines + per-stage token accounting + savings
codebuddy symbols src/<f>.ts                    # PASS: symbol signatures + line ranges + savings comparison
```

## 6. Suggestions [file]

```bash
codebuddy suggest --git                         # PASS: severity-tagged, evidence-backed findings (or "no suggestions")
codebuddy suggest --paths src/<f>.ts --json     # PASS: suggestions[] each with evidence[]; never edits files
```

## 7. Plans & risk [file]

```bash
codebuddy plan new "test plan"                  # PASS: creates a draft (opens $EDITOR)
codebuddy plan list                             # PASS: lists it
codebuddy risk assess --git                     # PASS: scored paths or "no risk evidence"
```

## 8. Client rules (advisory automation) [file]

```bash
codebuddy rules show --client claude            # PASS: prints the workflow template
codebuddy rules install --client claude         # PASS: writes managed block into CLAUDE.md
codebuddy rules install --client claude         # PASS: "unchanged" (idempotent)
grep -c "codebuddy:workflow:start" CLAUDE.md    # PASS: exactly 1
```

## 9. Hooks (enforced automation) [file]

```bash
codebuddy hooks install --client claude         # PASS: writes .claude/settings.json
codebuddy hooks status                          # PASS: "installed"
cat .claude/settings.json                        # PASS: UserPromptSubmit/PostToolUse/Stop entries

# Simulate the three hook events (payloads on stdin):
echo '{"cwd":"'"$PWD"'","session_id":"t"}' | codebuddy hooks context   # PASS: prints "## CodeBuddy project context"
echo '{"cwd":"'"$PWD"'","session_id":"t","tool_input":{"file_path":"'"$PWD"'/src/x.ts"}}' | codebuddy hooks stage
cat .codebuddy/cache/hooks/t.json               # PASS: staged src/x.ts
echo '{"cwd":"'"$PWD"'","session_id":"t"}' | codebuddy hooks capture 2>&1  # PASS: "captured from 1 changed file(s)"

codebuddy hooks uninstall --client claude       # PASS: removes only CodeBuddy hooks
codebuddy hooks status                          # PASS: "not installed"
```

## 10. Automatic memory + review [file]

After a hook capture (step 9) or an MCP `context_after_turn`:

```bash
codebuddy memory review                         # PASS: lists any captured candidates (⚠ marks sensitive)
codebuddy memory review show <id>
codebuddy memory review approve <id>            # PASS: promotes to a durable fact in .codebuddy/memory/facts/
```
Sensitivity check: capture a turn mentioning `password is hunter2secret` → it
must be **queued (flagged), never auto-saved**.

## 11. Database path [db]

```bash
codebuddy postgres up                           # bundled pgvector (needs Docker)
export DATABASE_URL="postgres://codebuddy:codebuddy@localhost:5432/codebuddy"
codebuddy migrate                               # PASS: "migrations applied"
codebuddy doctor                                # PASS: DB ok, pgvector ok
```
If doctor shows `password authentication failed for user "<you>"`, the URL lacks
credentials — set `DATABASE_URL` as above. This does not affect steps 2–10.

### 11a. Markdown recovery (automated) [db]

The one integration test that skips without a live database
(`src/db/storage-recovery.integration.test.ts`) verifies that deleted fact/
summary rows rebuild from their Markdown source. Run it end-to-end — brings
Postgres up, runs the test, tears it down:

```bash
npm run test:pg                                 # PASS: recovery test runs (not skipped) and passes
```

Requires Docker on PATH. The harness sets `CODEBUDDY_TEST_DATABASE_URL`
automatically; to point at an existing database instead, export that variable
and run `npx vitest run src/db/storage-recovery.integration.test.ts` directly.

## 12. End-to-end in a real client [mcp]

```bash
codebuddy use <project>                          # wires MCP + namespace + DB
# restart Claude Code (or Codex)
```
- In Claude Code, with hooks installed, ask the agent to make a small change.
  **PASS:** the hooks fire automatically and capture recall/staging/capture
  without depending on model compliance.
- In Claude Code or Codex, with rules installed, ask the agent to make a small
  change. **PASS:** it calls `context_bootstrap`/`context_before_edit` first
  and `context_after_turn` at the end as instructed by the workflow template.
- Then `codebuddy memory review` shows what was captured. **PASS.**

## 13. Cleanup

```bash
npm rm -g @ayushkumar320/codebuddy
rm -f ayushkumar320-codebuddy-2.0.0.tgz
```

---

## Release (only after all PASS)

```bash
git tag v2.0.0 && git push origin v2.0.0
npm login
npm publish --access public                     # prepublishOnly re-runs typecheck+test+build
```

## Sign-off

- [ ] Section 0 automated gate green
- [ ] Sections 2–10 file-based features verified
- [ ] Section 11 database path verified (or explicitly deferred)
- [ ] Section 12 verified in a real client
- [ ] Cleaned up the global install
