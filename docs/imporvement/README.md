# CodeBuddy Context Management Improvement Plan

Status: completed baseline plus proposed next improvements  
Source: repository and documentation audit, 2026-07-11; README feedback review,
2026-07-13  
Primary goal: make CodeBuddy a genuinely automatic, trustworthy, low-token
context-management system for coding agents.

> The directory name `imporvement` is retained because it was explicitly
> requested. New links should use this exact spelling unless the directory is
> intentionally renamed in a separate documentation cleanup.

## Desired end state

CodeBuddy should automatically prepare the smallest useful context for the
current task, avoid resending unchanged information, capture only durable and
evidence-backed knowledge, and prove its token savings across an entire
session. The working tree remains authoritative, all important decisions remain
inspectable, and the core path continues to work without a hosted service or a
mandatory LLM.

The original work was divided into five sequential phases. Those phases now form
the completed baseline for the automatic context engine. The next improvement
track should build on that baseline instead of reopening it: make compressed
context more relational, make memory confidence evidence-backed, make agent
workflow limits explicit, and make the documentation explain the system's
decisions clearly enough that a user can trust them.

## Global engineering rules

These rules apply to every phase:

- Preserve local-first and offline operation.
- Keep retrieval deterministic when embeddings or an LLM are unavailable.
- Never silently exceed the configured token budget.
- Treat source files and Git state as authoritative; memory is supporting
  evidence, not truth.
- Preserve existing public CLI, MCP, and SDK contracts unless a phase explicitly
  requires a backwards-compatible extension.
- Reuse the existing stores, packer, token-estimation seam, and test fixtures
  where practical.
- Do not modify or discard unrelated working-tree changes.
- Add focused unit tests and at least one integration-style test for each new
  workflow.
- Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before
  marking a phase complete.
- If an environment prevents a test from running, report the exact limitation;
  do not describe the phase as fully verified.
- Update `README.md`, `docs/current-version.md`, `docs/roadmap.md`, and relevant
  operational documentation whenever user-visible behavior changes.

## Phase summary

| Phase | Priority | Outcome | Depends on |
|---|---:|---|---|
| 1. Trust and budget correctness | P0 | Safe review storage, enforced budgets, deduplicated capture, validated hook paths | none |
| 2. Task-relevant retrieval | P1 | Context selected by task and evidence, including durable decisions and facts | Phase 1 |
| 3. Cross-turn token reduction | P1 | Unchanged context is not resent during a session | Phases 1–2 |
| 4. Incremental performance | P2 | Prompt latency scales with changed files rather than repository size | Phases 1–3 |
| 5. Evidence-backed memory and honest metrics | P2 | Durable memory is traceable, maintainable, and savings are measured end to end | Phases 1–4 |

---

## Next improvement track from README feedback

Status: proposed on 2026-07-13.

The README feedback marked `[MOBI]` points to a real next product gap:
CodeBuddy can compress context, but compressed context must not become shallow.
A one-line file summary saves tokens, but it can hide the relationships an
agent needs to edit safely. The next track should move from "small summaries" to
"small evidence-backed relation capsules."

### Product diagnosis

The current context engine is strongest at:

- avoiding broad source reads;
- keeping payloads bounded;
- preserving safety evidence such as policies and incidents;
- capturing durable memory after a turn;
- avoiding repeated context in hook-driven sessions.

The remaining weakness is not raw retrieval. It is **meaning preservation under
compression**. A compact payload should answer:

- what this file or module is responsible for;
- what public contracts it exposes;
- what it depends on locally;
- what depends on it;
- what tests or docs support it;
- which policies, incidents, decisions, or plans make it risky;
- whether the latest claim about it is confirmed by docs and implementation.

If a capsule cannot answer those questions, the agent will either over-read the
source again or act with false confidence.

### New phase summary

| Phase | Priority | Outcome | Depends on |
|---|---:|---|---|
| 6. Relation capsules | P1 | Replace one-line summaries as the main retrieval unit with compact file/module relation capsules | completed Phase 4 cache/index baseline |
| 7. Evidence-backed confidence scoring | P1 | Rate memory candidates by agreement between docs, architecture, implementation, tests, and observed work | completed Phase 5 evidence metadata |
| 8. Worklog and cross-chat continuity | P2 | Keep a chronological, inspectable record of work done, files touched, decisions made, and follow-up routes | Phase 7 preferred |
| 9. Agent workflow discipline | P2 | Add command budgets, task modes, fallback rules, and smallest-sufficient implementation guidance | templates/hooks baseline |
| 10. Documentation truth cleanup | P1 | Explain confidence, suggestions, fallback behavior, and graph-vs-capsule positioning clearly | can run in parallel |

---

## Phase 6 - Relation capsules

Status: proposed.

### Problem

The README currently describes background indexing as building a content hash
and one-line summary per file. That is useful for token savings, but it is not
always enough context for safe editing. A one-line summary can say "exports
buildBeforeEditContext" while omitting the more important information: this
module consumes policies, plans, incident memory, file summaries, symbols,
neighbours, and the budget packer.

This creates two bad outcomes:

- the agent reopens source files because the summary is too vague;
- the agent trusts a summary that does not show dependencies or risk.

The system should keep CodeBuddy's bounded, local-first design while adding a
small relational layer per file or module.

### Required implementation

1. Define a `RelationCapsule` as a deterministic, compact representation of a
   file or module.
   - `path`
   - `language`
   - `purpose`
   - `exports`
   - `importantLocalDependencies`
   - `knownDependents`
   - `relatedTests`
   - `relatedDocs`
   - `sideEffects`
   - `configurationTouched`
   - `policies`
   - `incidents`
   - `decisions`
   - `confidence`
   - `explain`
2. Build capsules from existing local evidence first.
   - Index manifest summaries and symbol tables.
   - Architecture cache import edges.
   - File naming conventions for tests.
   - Plans and memory facts with matching paths.
   - Policies and incidents with matching globs.
   - Leading file comments or obvious module-level documentation when available.
3. Keep the capsule bounded.
   - Store only the top few dependencies and dependents.
   - Prefer exported contracts over internal implementation details.
   - Prefer exact path and symbol matches over broad graph expansion.
   - Include omission explanations when important candidates are dropped.
4. Make capsules replace or enrich the current file summary in
   `context_before_edit`.
   - For tight budgets, emit a compressed capsule.
   - For normal budgets, emit the full capsule.
   - For symbol-targeted tasks, emit the capsule plus the matched symbol slice.
5. Store capsules as rebuildable cache, not source of truth.
   - They may live under `.codebuddy/cache/`.
   - They must be invalidated by file hash, graph cache version, policy changes,
     memory changes, or docs changes that affect the capsule.

### Example capsule

```text
path: src/context/engine.ts
purpose: Builds bootstrap and before-edit context payloads.
exports:
  - buildBootstrapContext
  - buildBeforeEditContext
depends_on:
  - src/risk/service.ts: resolves targets and risk evidence
  - src/savings/packer.ts: packs optional sections into the budget
  - src/core/memory-file-store.ts: reads facts, decisions, and incidents
used_by:
  - src/cli/commands/context.ts
  - src/mcp/tools/*
related_tests:
  - src/context/engine.test.ts
risk:
  - budget correctness
  - memory truthfulness
confidence:
  score: 0.84
  reasons:
    - exports confirmed from symbol table
    - dependencies confirmed from architecture cache
    - tests inferred by path and confirmed present
```

### Acceptance criteria

- A relation capsule can explain a target file's purpose, public API, key local
  dependencies, known dependents, and related tests without reading the full
  source.
- `context_before_edit` under a tight budget keeps the relation capsule for the
  target file before low-value neighbours.
- A task that names a function receives the file capsule plus that function's
  signature or slice.
- Capsule generation is deterministic and works offline.
- Capsule generation does not require a hosted service, mandatory LLM, or
  database.
- Capsule output includes `explain[]` reasons and omission reasons.
- Stale capsules are invalidated by source hash and relevant cache version.

### Codex execution prompt

```text
Implement Phase 6 from docs/imporvement/README.md. Preserve unrelated working
tree changes, especially user comments in README.md.

Objective: replace shallow one-line file summaries in automatic context with
bounded relation capsules that preserve purpose, contracts, local dependencies,
dependents, tests, docs, policies, incidents, decisions, and confidence reasons.

Start by tracing the current summary and symbol flow from the indexer into
context_before_edit. Reuse the existing index manifest, symbol table,
architecture cache, policy matcher, and memory file store. Do not create a
separate authoritative graph. Design a small RelationCapsule type and a builder
that operates from existing local evidence. Keep all fields capped and
deterministic.

Integrate capsules into budget packing. Target file capsules should outrank
secondary neighbours, but safety policies and unresolved incidents must still
win. Under tight budgets, emit compressed capsules and explain omitted fields.
When the task names a symbol, include the matching signature or slice beside the
capsule.

Add tests for offline deterministic capsule generation, target-file priority
under tight budgets, source-hash invalidation, dependency/dependent extraction,
related test detection, and omission explanations. Run typecheck, lint, tests,
and build. Update README.md, docs/current-version.md, and docs/roadmap.md only
after behavior is verified.
```

---

## Phase 7 - Evidence-backed confidence scoring

Status: proposed.

### Problem

The README says automatic capture can auto-save "confident facts" and queue
"low-confidence" items, but it does not define confidence clearly enough.
Confidence should not mean "the sentence sounds confident." It should mean
multiple project evidence sources agree.

The scoring model should compare:

- architecture docs;
- supporting docs;
- plans and roadmap/build docs;
- implementation files;
- exported symbols and schemas;
- related tests;
- observed changed files;
- observed verification results;
- prior durable memory.

When these sources agree, a candidate can become durable memory. When they
conflict, the candidate should be queued for review as possible doc drift,
stale memory, or an implementation mismatch.

### Confidence levels

High confidence:

- architecture or supporting docs describe the behavior;
- implementation contains matching code, exports, schemas, routes, or tests;
- changed files or command results support the claim;
- no current evidence directly contradicts it.

Medium confidence:

- implementation and agent summary agree;
- docs are missing, vague, or stale;
- tests are absent or indirect;
- no direct contradiction is found.

Low confidence:

- only the agent summary claims it;
- docs and implementation disagree;
- the wording is speculative or future-looking;
- the claim describes completed implementation without changed-file evidence;
- the claim conflicts with newer durable memory.

### Example

```text
candidate:
  context_before_edit enforces the configured token budget before returning
  ordinary payloads.

confidence:
  score: 0.92
  level: high
  reasons:
    - docs/imporvement/README.md says Phase 1 requires enforced budgets
    - src/context/engine.ts routes optional sections through the packer
    - src/savings/packer.ts implements deterministic budget packing
    - tests cover tight-budget behavior
decision:
  auto-save durable fact
```

Contradictory example:

```text
candidate:
  N.4 session capsule ledger is the next roadmap item.

confidence:
  score: 0.35
  level: low
  reasons:
    - docs/build/current-phase.md says N.4 is next
    - docs/roadmap.md says N.4 is shipped
    - implementation appears to contain session ledger support
decision:
  queue for review as documentation drift
```

### Required implementation

1. Add a confidence scorer for memory candidates.
   - Inputs: candidate, changed files, task summary, plan id, docs evidence,
     implementation evidence, tests evidence, command evidence, prior memory.
   - Output: numeric score, level, reasons, contradictions, missing evidence.
2. Add deterministic evidence collectors.
   - Documentation lookup by path, heading, and terms.
   - Implementation lookup by path, symbol, schema, route, and relation capsule.
   - Test lookup by naming convention and import/dependent relationships.
   - Verification lookup from explicitly observed command results.
3. Treat contradiction as first-class evidence.
   - Conflicting docs should reduce confidence.
   - Docs/code mismatch should queue review.
   - Existing memory supersession should avoid returning stale truth.
4. Store confidence metadata with durable and review items.
   - `confidenceScore`
   - `confidenceLevel`
   - `evidence`
   - `contradictions`
   - `missingEvidence`
   - `reviewReason`
5. Keep the scorer conservative.
   - Never auto-save secrets.
   - Never auto-save speculative claims.
   - Never auto-save implementation-complete claims without repository
     evidence.

### Acceptance criteria

- Confidence reasons are visible to the user in review output.
- A candidate supported by docs, implementation, and tests is auto-saveable.
- A candidate supported only by assistant prose is review-only or ignored.
- A docs/code contradiction queues a review item rather than creating durable
  truth.
- Confidence scoring works offline and does not require an LLM.
- Sensitive candidates remain redacted regardless of confidence score.

### Codex execution prompt

```text
Implement Phase 7 from docs/imporvement/README.md after Phase 6 is complete.
Preserve unrelated edits.

Objective: replace vague confidence gating with evidence-backed confidence
scoring. A memory candidate should be auto-saved only when project evidence
supports it and no stronger current evidence contradicts it.

Trace captureAfterTurn, deterministic extraction, ReviewStore, and
MemoryFileStore. Design a backwards-compatible confidence metadata schema.
Build deterministic evidence collectors for docs, implementation symbols,
relation capsules, related tests, changed files, observed command results, and
prior memory. Score agreement, missing evidence, and contradictions separately.

Update capture gating so high-confidence supported facts can save, medium and
low confidence candidates queue or drop, and contradictions become explicit
review reasons. Add tests for supported facts, assistant-only claims,
speculative claims, docs/code mismatch, stale doc conflict, missing tests, and
sensitive content. Update review CLI output to show confidence reasons. Run
focused tests, typecheck, lint, full tests, and build.
```

---

## Phase 8 - Worklog and cross-chat continuity

Status: proposed.

### Problem

Durable facts and plans are useful, but they do not fully answer a practical
question: "What did the agent actually do over time?" A user may want a compact
history of work across chats without reading git history or raw transcripts.

The system should maintain a chronological worklog that records:

- task summary;
- files touched;
- important changes;
- decisions made;
- incidents found or resolved;
- tests or commands run;
- follow-up risks;
- related plan;
- related commit when available.

This should be different from durable memory. A worklog is a timeline. Durable
memory is reusable project truth.

### Required implementation

1. Add a local worklog store.
   - Suggested path: `.codebuddy/worklog/` or `.codebuddy/memory/worklog/`.
   - Use Markdown files with front matter.
   - Keep entries readable and commit-safe, unless project config marks them
     private.
2. Write worklog entries after meaningful turns.
   - Hook capture can create entries from staged files and transcript summary.
   - MCP `context_after_turn` can create entries from changed files and summary.
3. Link worklog entries to memory.
   - Saved facts can cite the worklog entry that produced them.
   - Review items can cite the worklog entry for context.
4. Add CLI inspection.
   - `codebuddy worklog list`
   - `codebuddy worklog show <id>`
   - `codebuddy worklog latest`
   - optional `codebuddy worklog summarize --since <date>`
5. Keep privacy explicit.
   - Do not store raw transcripts by default.
   - Do not store secrets.
   - Redact sensitive snippets.

### Acceptance criteria

- A completed turn creates one concise worklog entry without duplicating durable
  facts.
- The worklog shows files touched and verification results when available.
- A future capture can refer to prior worklog entries instead of requiring the
  user to explain the same fix again.
- Worklog entries are bounded and inspectable Markdown.
- Sensitive content is redacted or omitted.

---

## Phase 9 - Agent workflow discipline

Status: proposed.

### Problem

Token waste does not only come from context payloads. Agents also waste tokens
and time by:

- running unnecessary commands;
- exploring too broadly;
- thinking in the wrong mode for the task;
- writing larger code than needed;
- continuing after enough evidence is already available.

CodeBuddy should help clients install workflow rules that keep the agent inside
the smallest useful loop for the task.

### Required implementation

1. Add command budget guidance.
   - A task can declare a command budget such as "light", "normal", or
     "thorough".
   - The agent should spend commands on highest-signal checks first.
   - The agent should explain when it exceeds the expected budget.
2. Add task modes.
   - `bugfix`: reproduce, inspect narrow code, patch root cause, run focused
     verification.
   - `docs`: read source of truth, update docs, avoid code changes.
   - `refactor`: preserve behavior, add characterization tests where needed.
   - `release`: run full verification and packaging checks.
   - `architecture`: use graph/context first, then verify against source.
3. Add fallback rules.
   - If a context tool fails, use cached docs and direct source reads.
   - If Postgres is unavailable, keep file-based tools working.
   - If the index is stale, explain degraded mode and rebuild when appropriate.
   - If a command fails because of environment limits, report the limitation
     without inventing success.
4. Add smallest-sufficient-implementation guidance.
   - Prefer existing helpers and patterns.
   - Ask whether a simpler implementation preserves behavior.
   - Avoid new abstractions unless they remove real complexity.
   - Keep edits scoped to the task.

### Acceptance criteria

- `codebuddy rules show` includes clear tool-use and fallback rules.
- Agent templates explain when to use each context tool and when not to.
- Command-budget guidance is advisory but explicit.
- Task modes can be selected or inferred without changing core engine behavior.
- Documentation makes clear that workflow rules reduce waste but do not replace
  verification.

---

## Phase 10 - Documentation truth cleanup

Status: proposed.

### Problem

The docs currently contain both completed implementation history and next-step
planning. Some docs can drift, for example one document may say an item is
shipped while another still calls it next. The README also uses terms such as
"confident facts", "suggestions", "fallback", and "graph" without enough
examples for a new user.

### Required documentation changes

1. README.
   - Remove raw planning comments after converting them into tracked docs.
   - Explain confident vs low-confidence capture with examples.
   - Explain how suggestions are produced from evidence.
   - Explain fallback/degraded behavior in the feature tour.
   - Reposition graph comparison as "bounded relation capsules vs giant
     whole-repo graph" once Phase 6 exists.
2. `docs/current-version.md`.
   - Keep it as the verified-current behavior snapshot.
   - Avoid future-tense plans here.
3. `docs/roadmap.md`.
   - Keep only remaining work.
   - Mark completed work as shipped or move it to history.
4. `docs/build/current-phase.md`.
   - Ensure it does not name shipped work as "next".
5. `docs/improvements.md`.
   - Mark the old backlog as completed history if all items are closed.
6. `docs/imporvement/README.md`.
   - Keep this file as the detailed improvement program.
   - Preserve the misspelled directory name unless a separate cleanup renames it.

### Acceptance criteria

- No doc says an item is both shipped and next.
- README explains confidence levels with concrete examples.
- README explains suggestion evidence.
- README explains fallback behavior at the point where templates/hooks are
  introduced.
- Roadmap lists only real remaining work.
- Improvement docs separate history from proposed future work.

## Phase 1 — Trust and budget correctness

Status: implemented and verified on 2026-07-11. Typecheck, lint, build, and all
280 runnable tests pass; the PostgreSQL recovery integration test remains
environment-gated and skipped.

### Problem

The configured token budget is currently used to measure a completed payload,
not to constrain it. Sensitive candidates are written to
`.codebuddy/memory/review/`, but that directory is not ignored by the generated
`.codebuddy/.gitignore`. Hook-based capture can save the same fact repeatedly,
and staged edit paths are normalized without proving that they remain inside the
repository.

### Primary files

- `src/context/engine.ts`
- `src/context/types.ts`
- `src/savings/packer.ts`
- `src/core/config-file.ts`
- `src/memory-extract/engine.ts`
- `src/memory-extract/review-store.ts`
- `src/core/memory-file-store.ts`
- `src/hooks/runtime.ts`
- `src/hooks/staging.ts`
- corresponding `*.test.ts` files

### Required implementation

1. Enforce the token budget on the final context payload.
   - Convert optional context sections into explicit pack candidates.
   - Use a deterministic priority order: matching safety policy, unresolved
     incidents touching targets, active-plan constraints, target symbols,
     direct neighbours, then secondary context.
   - Reserve space for required envelope fields and token statistics.
   - Use compressed renderings where available and omit candidates that do not
     fit.
   - Re-estimate the final serialized response and guarantee that it is within
     budget, apart from a documented minimal-envelope case.
   - Return inclusion, compression, and omission reasons.
2. Protect the review queue.
   - Add `/memory/review/` to newly generated `.codebuddy/.gitignore` files.
   - Safely append the rule to existing scaffolds without deleting user rules.
   - Never store a detected secret verbatim in a review file. Store a redacted
     representation plus sensitivity reasons.
3. Deduplicate automatic capture.
   - Compute a stable fingerprint from normalized namespace, class, subject,
     predicate, content, and sorted paths.
   - Persist the fingerprint in fact and review metadata.
   - Make repeated capture idempotent and merge compatible metadata rather than
     creating another file.
4. Validate edited paths.
   - Resolve every hook-reported path against the repository root.
   - Ignore and explain paths that escape the repository or belong to another
     workspace.
   - Make staging writes and drains atomic enough to avoid losing concurrent
     edit events.

### Acceptance criteria

- A 100-token or 500-token request never returns an oversized ordinary payload.
- Critical policies and matching incidents survive before lower-priority
  neighbours when the budget is tight.
- A sensitivity fixture containing a token or password produces no verbatim
  secret in durable or review Markdown.
- `git status --short` does not expose review-queue files after scaffold setup.
- Replaying the same capture input produces one durable fact or review item.
- Concurrent stage operations retain the union of valid changed paths.
- `../../outside.ts` and external absolute paths are rejected.
- Existing context responses remain backwards compatible where fields are
  retained; newly omitted data is explained.

### Codex execution prompt

```text
You are implementing Phase 1 of CodeBuddy's context-management improvement
plan. Read docs/imporvement/README.md completely, then inspect the current
working tree and preserve unrelated edits.

Objective: close the P0 trust and correctness gaps in token-budget enforcement,
sensitive review storage, capture deduplication, hook path validation, and hook
staging concurrency.

First trace buildBootstrapContext and buildBeforeEditContext through token
measurement. Confirm that the existing packByBudget function is not currently
enforcing the final payload. Design a small internal candidate representation
for context sections and connect it to the existing packer. Define and document
a deterministic priority order. Reserve budget for mandatory envelope fields,
pack optional sections, serialize the final payload, and verify the actual final
estimate. Do not merely change withinBudget reporting. Add tests with very tight
budgets proving that safety policy and matching incidents beat neighbours and
that the final ordinary payload stays within budget.

Next inspect initProjectScaffold, ReviewStore, captureAfterTurn, and the Markdown
front-matter schemas. Add /memory/review/ to generated and existing project
gitignore configuration. When sensitivity scanning triggers, redact the stored
candidate content and object so a detected credential is never written verbatim.
Preserve enough metadata for a user to understand why it was queued. Add a Git
visibility test and a test that searches the resulting files for the original
secret.

Then make hook capture idempotent. Introduce a versioned, stable fingerprint
based on normalized semantic fields and sorted paths. Persist it in durable fact
and review metadata with backwards-compatible schema handling. Before writing,
find an exact existing fingerprint and return a deduplicated decision or merge
safe metadata. Add replay tests for saved facts and review items.

Finally harden hook staging. Reject paths outside repositoryRoot, normalize valid
paths consistently, and replace unsafe read-merge-write/drain behavior with an
atomic or locked design. Add concurrent add/drain tests and traversal tests.

Keep the system local-first and deterministic. Do not add a mandatory database,
LLM, or network call. Update affected docs so token budgets are described as
enforced rather than merely measured only after the implementation proves it.
Run typecheck, lint, the focused tests, the full test suite, and build. Report
changed files, behavioral decisions, migration considerations for existing
.codebuddy scaffolds, exact verification results, and any residual risks.
```

---

## Phase 2 — Task-relevant retrieval

Status: implemented and verified on 2026-07-11. Deterministic task/path ranking,
bounded general-fact retrieval, task-ranked symbols, explanations, and an
optional failure-safe semantic ranker are wired into before-edit context.

### Problem

`context_before_edit` accepts a task string but only echoes it in the response.
Selection is driven mainly by paths and import degree. Automatic context reads
incident facts but omits ordinary durable facts and decisions. Deterministic file
summaries are often limited to language, line count, and export names, which may
be too weak to prevent follow-up source reads.

### Primary files

- `src/context/engine.ts`
- `src/context/types.ts`
- `src/core/memory-file-store.ts`
- `src/indexer/summary.ts`
- `src/indexer/symbols.ts`
- `src/savings/packer.ts`
- optional provider/embedding interfaces, without making them mandatory
- relevant CLI and MCP context tests

### Required implementation

1. Add deterministic task relevance.
   - Tokenize and normalize the task, paths, symbol names, summaries, policies,
     incidents, plans, and durable facts.
   - Score exact path and symbol matches above loose lexical overlap.
   - Combine relevance with safety/risk priority rather than replacing it.
   - Keep stable tie-breaking and expose score components in explanations.
2. Retrieve compact general facts and decisions.
   - Select by namespace, path, task terms, plan, and recency.
   - Cap the candidate pool and final included set.
   - Deduplicate text already represented by a plan, policy, or incident.
3. Add optional semantic ranking behind an interface.
   - Use embeddings when already available.
   - Never block on embedding generation.
   - Preserve lexical/path ranking as the deterministic offline fallback.
4. Improve deterministic summaries.
   - Include module purpose, important exported contracts, important local
     dependencies, side effects or configuration, and associated tests where
     these can be extracted cheaply.
   - Prefer symbol slices over vague summaries when a target symbol matches the
     task.

### Acceptance criteria

- Two different tasks over the same path produce meaningfully different ranked
  context under a tight budget.
- A saved architectural decision relevant to the task appears automatically.
- Unrelated facts do not displace matching policies, incidents, or symbols.
- Offline behavior remains deterministic and fully functional.
- Semantic ranking failure produces the same valid fallback result as offline
  mode.
- Explanations identify why each selected item was relevant.

### Codex execution prompt

```text
Implement Phase 2 from docs/imporvement/README.md after confirming Phase 1 is
complete and its tests pass. Preserve unrelated working-tree changes.

Objective: make automatic context genuinely relevant to the user's current task
while preserving strict budgets, deterministic offline behavior, and safety
priority.

Trace how task, paths, plans, policies, incidents, facts, summaries, symbols, and
architecture neighbours flow into buildBeforeEditContext. Introduce a small,
testable deterministic relevance scorer. Normalize task terms conservatively;
score exact path, filename, exported symbol, and policy/incident matches above
generic word overlap. Combine relevance with the Phase 1 safety priority and use
stable tie-breaking. Include score components and human-readable reasons in
explain output.

Extend MemoryFileStore or an appropriate query layer to retrieve bounded general
facts and decisions for the namespace. Rank them by target-path match, task
overlap, active-plan association when available, confidence, and recency. Do not
dump the memory directory. Deduplicate any fact already conveyed by the plan,
policy, or incident sections. Add the resulting candidates to budget packing.

Define an optional semantic-ranking interface that can consume embeddings that
already exist. It must have a timeout/failure-safe path and must never make an
LLM or network service mandatory. Verify that unavailable or pending embeddings
fall back to the deterministic ranking without changing response validity.

Improve deterministic file summaries only where reliable information can be
extracted cheaply. Include purpose from leading documentation, public contracts,
important local dependencies, obvious side effects/configuration, and related
test paths. When the task names a symbol, prefer a compact symbol signature or
slice instead of a generic module summary.

Add adversarial tests: same paths with different tasks, relevant versus recent
but unrelated facts, safety evidence versus high lexical similarity, no
embeddings, failed embeddings, and tight budgets. Update MCP/CLI output docs if
the schema is extended. Run focused tests, typecheck, lint, the full suite, and
build. Report ranking rules, caps, fallback behavior, verification evidence, and
remaining retrieval limitations.
```

---

## Phase 3 — Cross-turn token reduction

Status: implemented and verified on 2026-07-11. Claude hooks use a versioned,
bounded, age-limited session capsule ledger with atomic writes, per-session
locking, selective invalidation, corruption recovery, and cumulative delivery
statistics.

### Problem

Claude hooks inject similar bootstrap information on every prompt. The system
optimizes an individual payload but has no session-level knowledge of context
already sent. Repeated context can therefore dominate total session cost.

### Primary files

- `src/hooks/runtime.ts`
- `src/hooks/settings.ts`
- new session-ledger module under `src/context/` or `src/hooks/`
- `src/context/engine.ts`
- `src/savings/types.ts`
- MCP context schemas if session identity is exposed there
- hook and multi-turn tests

### Required implementation

1. Create a versioned session capsule ledger under
   `.codebuddy/cache/session/<sessionId>.json`.
2. Identify each capsule by a hash of its canonical content and relevant scope.
3. Send a capsule in full once per session; subsequently send a stable reference
   until its content hash changes.
4. Separate stable project context from task-specific and changed context.
5. Emit context in stable, prompt-cache-friendly order.
6. Add bounded ledger lifetime, cleanup, corruption recovery, and atomic writes.
7. Measure cumulative candidate, sent, referenced, and avoided tokens across a
   simulated session.

### Acceptance criteria

- A second unchanged prompt sends references instead of full stable capsules.
- Changing a policy, plan, fact, incident, or indexed summary invalidates only
  the affected capsule.
- Different sessions do not suppress each other's context.
- A corrupt or missing ledger safely behaves like a fresh session.
- Ledger files are local, ignored by Git, bounded, and atomically written.
- Multi-turn tests demonstrate a material cumulative reduction without hiding
  newly changed context.

### Codex execution prompt

```text
Implement Phase 3 from docs/imporvement/README.md after Phases 1 and 2 are green.
Preserve unrelated edits.

Objective: stop resending unchanged context within a session while ensuring any
changed safety, plan, memory, or code capsule is sent immediately.

Design a versioned SessionCapsuleLedger stored at
.codebuddy/cache/session/<safeSessionId>.json. Use canonical serialization and a
stable content hash for capsule identity. The first occurrence of a capsule must
send its compact full content. Later occurrences in the same session should send
a short stable reference. If content changes, send the new full capsule and
update the ledger. Do not use path alone as identity. Keep sessions isolated.

Integrate the ledger first with Claude hook context using the hook session_id.
If MCP context calls can safely accept an optional sessionId without breaking
clients, add it as an optional schema field and document it. Separate stable
project context from turn-specific paths, risk, and task context. Emit sections
in a stable order suitable for provider prompt caching: project identity,
policies, active plan, durable capsules, then changing task/edit context.

Use atomic writes, safe session filenames, a bounded maximum number of capsules,
and age-based cleanup. Treat missing, stale, incompatible, or malformed ledgers
as empty. The cache must never become a source of truth.

Add multi-turn tests covering first send, repeated send, single-capsule change,
new session, corrupt ledger, eviction, and concurrent writes. Extend savings
statistics with cumulative full, reference, and avoided token counts. Do not
claim provider billing savings; describe deterministic transmitted-context
reduction.

Run focused tests, typecheck, lint, the full suite, and build. Update the roadmap
status for N.4 only when every acceptance criterion is verified. Report the
ledger format, invalidation rules, cleanup behavior, schema compatibility,
measured multi-turn reduction, and residual risks.
```

---

## Phase 4 — Incremental performance

Status: implemented and verified on 2026-07-11. Indexing maintains a versioned
architecture cache, reparses only content-changed modules when the source set is
stable, rebuilds safely for additions/removals/renames, and exposes deterministic
read/reuse counters. Context loads one index snapshot and reuses it for graph,
symbols, and savings calculations.

### Problem

Bootstrap and before-edit calls rebuild the architecture map by recursively
reading source files. Context construction can also reopen files for symbols and
savings calculations. Prompt-hook latency therefore grows with repository size
even when nothing relevant changed.

### Primary files

- `src/indexer/engine.ts`
- `src/indexer/store.ts`
- `src/indexer/types.ts`
- `src/indexer/watch.ts`
- `src/map/indexer.ts`
- `src/context/engine.ts`
- `src/savings/engine.ts`
- new benchmark or performance-fixture files

### Required implementation

1. Persist architecture nodes and edges as a rebuildable, versioned cache.
2. Update graph entries only for added, changed, or removed files.
3. Let context retrieval consume the cached graph and current index manifest.
4. Introduce a request-level snapshot so paths, plans, memory metadata, index,
   graph, symbols, and savings share already-loaded data.
5. Avoid reading source when a current indexed summary or symbol table suffices.
6. Detect stale or incompatible caches and rebuild safely.
7. Add latency and file-read instrumentation suitable for deterministic tests.

### Acceptance criteria

- An unchanged context request does not recursively read every source file.
- Editing one file updates that file's summary, symbols, and graph edges without
  rebuilding unrelated entries.
- Deleted and renamed files leave no stale graph nodes.
- Missing or corrupt caches recover without blocking the agent permanently.
- Performance tests demonstrate work proportional to changed files after warmup.

### Codex execution prompt

```text
Implement Phase 4 from docs/imporvement/README.md after Phases 1 through 3 pass.
Preserve unrelated working-tree changes.

Objective: make warm context retrieval scale with changed files rather than total
repository size, without turning caches into authoritative state.

Profile or instrument the current bootstrap and before-edit paths. Document how
many directory walks and file reads occur. Design a versioned architecture-cache
format compatible with the existing index manifest or stored beside it. Persist
module nodes, resolved local-import edges, source hashes, and generation metadata.
Update only added, changed, and removed files during index/watch operations.
Handle renames as removal plus addition unless a simpler correct mechanism
already exists.

Refactor context construction around a request-level snapshot that loads config,
active plan, memory metadata, index manifest, and cached graph once. Reuse indexed
symbol tables and summaries when hashes are current. Pass already-resolved data
to risk, packing, and savings stages rather than reopening files. Keep direct
source fallback for missing/stale entries and explain degraded behavior.

Add deterministic instrumentation or injected filesystem adapters so tests can
assert file-read and rebuild counts without flaky wall-clock thresholds. Cover a
cold build, unchanged warm request, one-file edit, dependency change, deletion,
rename, corrupt cache, and version mismatch. Include a lightweight benchmark for
small and synthetic large repositories, but keep the normal test suite fast.

Run focused tests, typecheck, lint, the full suite, build, and the documented
benchmark. Report cache schema, invalidation behavior, cold versus warm work,
measured read-count improvements, recovery behavior, and remaining scalability
limits.
```

---

## Phase 5 — Evidence-backed memory and honest metrics

Status: implemented and verified on 2026-07-11. Durable facts carry optional
session, plan, commit, changed-path, and verification evidence; speculative
claims remain reviewable; decisions can explicitly supersede older facts;
incident resolutions update existing incidents; review overflow/expiry is
archived locally; and savings distinguish theoretical source compression from
observed session-context transmission. A checked-in extraction corpus guards
the deterministic baseline.

### Problem

Deterministic capture relies heavily on assistant prose and keyword matching.
Facts can describe intended rather than completed work, incident resolution is
not connected to earlier incidents, and conflicts or superseded decisions remain
for downstream agents to reconcile. Existing savings numbers compare context
against an assumed full read of all represented files rather than measuring
whole-session behavior.

### Primary files

- `src/memory-extract/deterministic.ts`
- `src/memory-extract/engine.ts`
- `src/memory-extract/types.ts`
- `src/core/memory-file-store.ts`
- `src/hooks/runtime.ts`
- risk incident signal files
- `src/savings/engine.ts`
- `src/savings/types.ts`
- documentation and evaluation fixtures

### Required implementation

1. Attach evidence metadata to captured memory.
   - Changed paths and diff/commit identifiers when available.
   - Test or command outcomes when explicitly observed.
   - Source turn/session and plan identifiers.
2. Make deterministic extraction more conservative.
   - Prefer explicit decision, root-cause, and completion markers.
   - Detect speculative language and route it to review.
   - Require repository evidence before auto-saving implementation claims.
3. Add lifecycle semantics.
   - Supersede prior decisions explicitly.
   - Link incident resolutions to incident fingerprints.
   - Decay or archive stale low-value items without silently deleting history.
4. Improve review-queue operation.
   - Deduplicate, expire, filter, and batch-review candidates safely.
5. Replace the single savings claim with transparent metrics.
   - Theoretical raw-source compression.
   - Actual context tokens sent.
   - Repeated tokens avoided by the ledger.
   - Follow-up source reads when observable.
   - Net cumulative session context.
6. Create an evaluation corpus containing positive, negative, speculative,
   contradictory, sensitive, duplicate, and resolution examples.

### Acceptance criteria

- Auto-saved implementation facts have traceable repository evidence.
- Speculative assistant statements never become durable facts automatically.
- A resolved incident no longer appears as an unresolved hotspot.
- Superseded decisions remain auditable but are not returned as current truth.
- Review queues remain bounded and contain no duplicate fingerprints.
- User-visible metrics clearly separate theoretical compression from observed
  transmitted-context reduction.
- Evaluation fixtures provide measurable precision, recall, and false-positive
  baselines for deterministic extraction.

### Codex execution prompt

```text
Implement Phase 5 from docs/imporvement/README.md after Phases 1 through 4 are
verified. Preserve unrelated edits.

Objective: make durable memory evidence-backed and maintainable, and make token
metrics honest across a complete session.

Begin by designing backwards-compatible evidence and lifecycle metadata for fact
Markdown. Include source session/turn, plan, changed paths, optional diff or
commit identity, and observed verification outcomes. Do not store raw transcripts
or secrets. Existing fact files must continue to parse with safe defaults.

Tighten deterministic extraction. Replace overly broad keyword confidence with
explicit patterns for decisions, completed implementation facts, incidents, root
causes, and resolutions. Detect speculation and future intent such as might,
could, consider, planned, should, and TODO; route those candidates to review.
Require corroborating changed-path/diff evidence before auto-saving claims that
code was implemented. Assistant prose alone may suggest a candidate but must not
prove it.

Add explicit supersession and incident-resolution workflows. A new decision can
identify the fact it supersedes. A resolution candidate should match an existing
incident by fingerprint and paths, then mark it resolved only when evidence is
adequate or after review. Keep historical files auditable. Ensure bootstrap and
risk retrieval return current decisions and unresolved incidents by default.

Make the review queue bounded and usable: exact fingerprint deduplication,
age/status filters, expiration or archival policy, and safe batch operations.
Never silently approve or delete sensitive entries.

Redesign savings reporting so theoretical raw-source compression is named
separately from actual context sent and session-ledger repetition avoided. When
follow-up file reads are observable through hooks, count them; otherwise report
the metric as unavailable rather than estimating it. Provide cumulative session
statistics without claiming provider billing savings.

Build a checked-in evaluation corpus with positive, negative, speculative,
duplicate, conflicting, sensitive, and incident-resolution examples. Add a test
or script that reports deterministic extractor precision, recall, and false
positives against this corpus. Establish a baseline and document acceptable
regression thresholds.

Run focused tests, evaluation, typecheck, lint, the full suite, and build. Update
README.md, ARCHITECTURE.md, docs/current-version.md, docs/degraded-mode.md, and
the roadmap to match verified behavior. Report schema migration, evidence rules,
lifecycle semantics, evaluation results, metric definitions, verification, and
remaining limitations.
```

---

## Completion definition

The improvement program is complete only when all five phases meet their
acceptance criteria and the living documentation matches verified behavior. The
final release checklist should demonstrate:

1. context payloads obey their configured budgets;
2. sensitive material is neither committed nor stored verbatim in review files;
3. replayed turns do not duplicate memory;
4. task wording changes retrieval priorities in explainable ways;
5. unchanged session context is represented by references rather than resent;
6. warm retrieval does not rescan the whole repository;
7. durable facts carry evidence and lifecycle state; and
8. savings reports distinguish theoretical compression from actual transmitted
   context reduction.

## Deferred work

The following items should remain separate unless they become necessary to meet
an acceptance criterion above:

- hosted synchronization or cloud memory;
- autonomous editing or merging;
- organization-wide or multi-repository knowledge graphs;
- mandatory LLM summarization;
- UI dashboards;
- publishing to npm;
- client lifecycle integrations that do not yet expose stable hook APIs.
