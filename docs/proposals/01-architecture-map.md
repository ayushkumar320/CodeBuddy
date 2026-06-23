# Proposal 01 — Architecture Map

Status: Draft
Owner: @ayushkumar320
Target: v0.2.0
Depends on: existing `MemoryRepository`, `pgvector`, the CLI runtime

## Why this exists

Every editor-integrated AI tool today consumes the repo as a flat soup of files.
The model loads a window, answers a question, and forgets. When the developer
asks "how does this work," the answer comes back as prose that the developer
has to mentally re-graph onto the codebase.

The Architecture Map is a persisted, queryable, incrementally-updated graph of
the repository that lives alongside CodeBuddy's memory. It is the substrate
that the Plan panel and the Risk panel both query — neither of them can do
their job without it.

This is **not** a visualisation feature. The renderer is the last 5% of the
work. The graph itself — kept in sync with the working tree, annotated with
memory, queryable by the SDK — is the product.

## Goals

1. Parse TypeScript, JavaScript, and Python sources into a module-and-symbol
   graph with file/line spans.
2. Persist the graph in Postgres alongside CodeBuddy's existing tables. One
   schema, one connection pool, one migration story.
3. Update the graph incrementally on file save; full rebuild only on first run
   or after schema migration.
4. Expose the graph via the SDK and via two new MCP tools (`map.query`,
   `map.neighbours`) so any MCP client can ask "what depends on `foo`."
5. Ship a CLI command (`codebuddy map`) that prints a textual summary suitable
   for piping into other tools.

## Non-goals (v0.2)

- Languages beyond TS/JS/Python. Rust, Go, Java come later behind the same
  parser interface.
- Type-level resolution. We extract syntactic edges, not the kind that
  `tsc --emitDeclarationOnly` would resolve. Type-aware analysis is a separate
  proposal; the schema must accommodate it but the v0.2 indexer doesn't do it.
- A graphical renderer. Renderer is a separate proposal (`05-workspace-ui`).
  v0.2 ships the headless graph + CLI + MCP tools.
- Cross-repo analysis. One repo per namespace.

## User-visible behaviour

```bash
# One-time index of the current repo into the codebuddy-<folder> namespace
codebuddy map build

# Updates incrementally on file save when `codebuddy map watch` is running
codebuddy map watch

# Query examples
codebuddy map deps src/core/codebuddy.ts          # what this file imports
codebuddy map dependents src/core/codebuddy.ts    # what imports this file
codebuddy map fanout src/db/repository.ts --depth 2
codebuddy map orphans                              # files with no inbound edges
codebuddy map hotspots                             # files with highest fanout × churn
```

Through MCP, the same queries are available to any agent under
`mcp__codebuddy-<ns>__map_*`.

## Architecture

### Layers

```
+---------------------------------------------------+
|  CLI (codebuddy map …)   MCP tools   SDK queries  |
+---------------------------------------------------+
|              Graph Query Service                  |
|       (cycles, fanout, paths, hotspots)           |
+---------------------------------------------------+
|              Graph Repository                     |
|        (Drizzle schema, pg queries)               |
+---------------------------------------------------+
|              Indexer                              |
|  parser pool ── change journal ── upsert batch    |
+---------------------------------------------------+
|              File watcher                         |
|         (chokidar, git-ignored aware)             |
+---------------------------------------------------+
```

### Data model

Three new Postgres tables, all scoped by `namespace_id` so existing
multi-namespace semantics still work.

```sql
-- modules: one row per file in the working tree
create table map_modules (
  id              text primary key,
  namespace_id    text not null references namespaces(id) on delete cascade,
  path            text not null,                 -- repo-relative POSIX
  language        text not null,                 -- 'ts' | 'js' | 'py'
  loc             integer not null,
  hash            text not null,                 -- sha256(file contents)
  last_indexed_at timestamptz not null default now(),
  unique (namespace_id, path)
);

-- symbols: top-level declarations exported or otherwise reachable
create table map_symbols (
  id              text primary key,
  namespace_id    text not null references namespaces(id) on delete cascade,
  module_id       text not null references map_modules(id) on delete cascade,
  name            text not null,
  kind            text not null,                 -- 'function' | 'class' | 'const' | 'type' | 'enum'
  start_line      integer not null,
  end_line        integer not null,
  exported        boolean not null default false,
  index (namespace_id, name),
  index (module_id)
);

-- edges: directed relationships between modules
create table map_edges (
  id              text primary key,
  namespace_id    text not null references namespaces(id) on delete cascade,
  src_module_id   text not null references map_modules(id) on delete cascade,
  dst_module_id   text not null references map_modules(id) on delete cascade,
  kind            text not null,                 -- 'import' | 'reexport' | 'dynamic_import' | 'type_only'
  src_symbol_id   text references map_symbols(id) on delete set null,
  dst_symbol_id   text references map_symbols(id) on delete set null,
  weight          integer not null default 1,    -- duplicate-edge counter
  unique (src_module_id, dst_module_id, kind, dst_symbol_id),
  index (namespace_id, src_module_id),
  index (namespace_id, dst_module_id)
);
```

Rationale:

- Module-level edges are sufficient for v0.2 risk + plan signals. Symbol-level
  edges live in their own field so we can fill them in later without a schema
  break.
- `hash` makes incremental indexing cheap — if the file's sha256 is unchanged
  we skip parsing entirely.
- `weight` collapses N duplicate imports of the same destination into a single
  row but tells you something about the strength of the dependency.

### Indexer pipeline

Workflow for a single file:

```
file event ─▶ debounced batch ─▶ language detect
                                   │
                                   ▼
                               sha256 hash
                                   │
                                   ▼
                         (skip if unchanged)
                                   │
                                   ▼
                          tree-sitter parse
                                   │
                                   ▼
                       walk AST, extract edges
                                   │
                                   ▼
                          resolve relative paths
                                   │
                                   ▼
                     write modules + symbols + edges
                          inside one transaction
```

Implementation notes:

1. **tree-sitter** runs in WASM via `web-tree-sitter` so it works in Node, in
   the eventual desktop renderer, and in CI. Grammars (`tree-sitter-typescript`,
   `tree-sitter-python`) are bundled.
2. **Parser pool**: at most `os.availableParallelism() - 1` workers. AST walks
   are CPU-bound; spawning a worker per file is wasteful.
3. **Path resolution** uses Node's `enhanced-resolve` for TS/JS (handles
   `tsconfig.json` paths, package.json exports). Python uses an internal
   resolver that respects `__init__.py` and `sys.path`-style roots from
   `pyproject.toml`.
4. **Batching**: file events from the watcher are debounced 250ms before they
   hit the indexer. A user save burst (formatter writing 12 files in 50ms) is
   one batch, not 12 transactions.

### File watcher

`chokidar` with the following rules:

- Roots from `git rev-parse --show-toplevel`.
- Ignore via `git check-ignore --stdin` (handles nested `.gitignore` files).
- Watch is opt-in (`codebuddy map watch`). The default `codebuddy use` does
  **not** start a watcher because users may want to opt out of the inotify
  pressure on large repos.

### MCP surface

Two new tools registered alongside the existing memory tools. Schemas in
`src/mcp/tools/map.ts`:

```ts
map_query({ from?: string; to?: string; kind?: EdgeKind; limit?: number })
  -> { edges: Edge[]; nextCursor?: string }

map_neighbours({ module: string; direction: "in" | "out" | "both"; depth: number })
  -> { modules: Module[]; edges: Edge[] }
```

Both return content that's safe to feed back into an LLM context window —
small, structured JSON, no unbounded recursion.

## Implementation phases

### Phase 1 — schema + migrations (1 day)

- Add `src/db/schema-map.ts` with the three tables above.
- Generate migration via `drizzle-kit generate`. The migrations folder is
  already shipped in `package.json#files`, so no packaging changes.
- Extend `MemoryRepository` interface in `src/core/repository.ts` with the
  new read/write methods (no behaviour change to existing implementations
  until phase 4).
- Add stub methods to `InMemoryMemoryRepository` (return empty arrays) so the
  test suite keeps passing.

### Phase 2 — TypeScript parser (3 days)

- `src/map/parsers/typescript.ts`: wraps `web-tree-sitter` with a typed
  walker.
- Returns a list of `Edge` and `Symbol` records keyed by source span.
- Tests against a fixture repo under `src/map/__fixtures__/ts-sample/`.
  Each fixture is a small synthetic project (5-15 files) hitting:
  named import, default import, re-export, dynamic `import()`,
  type-only import, `import { x as y }` aliasing, circular import.
- The walker must be conservative: when an import target can't be resolved
  (missing peer dep, unresolved alias), record the edge with
  `dst_module_id = null` and a `kind` of `unresolved`. The planner cares
  about unresolved imports too.

### Phase 3 — indexer + storage (2 days)

- `src/map/indexer.ts`: orchestrates the pipeline.
- `src/db/map-repository.ts`: Postgres-backed read/write of the new tables.
- `IndexerProgress` events emitted as the indexer runs (used by the CLI
  spinner and, later, by the workspace UI).
- Backpressure: the indexer reads from a bounded queue; if the queue fills,
  the watcher drops to "next-tick coalesce" mode where events accumulate
  until the queue drains.

### Phase 4 — CLI surface (1 day)

- `src/cli/commands/map.ts` with subcommands listed above.
- Each subcommand resolves the namespace from the current folder (same
  semantics as `codebuddy use`).
- `map build` runs to completion; `map watch` stays foreground and prints
  reindex events. `Ctrl-C` flushes any pending writes before exiting.

### Phase 5 — Python parser (3 days)

- `src/map/parsers/python.ts`: same shape as the TS parser.
- Resolves `from foo.bar import baz` against the project root, falling back
  to an unresolved edge otherwise.
- Decoupled from phase 4: ships in a follow-up minor release.

### Phase 6 — MCP tools (2 days)

- `src/mcp/tools/map.ts`: thin wrappers around the query service.
- Tests in `src/mcp/tools/map.test.ts` against the in-memory repository.
- Documentation: `codebuddy claude install` automatically picks these up
  because they register via the same tool registration path.

### Phase 7 — query service + hotspots (2 days)

- `src/map/query.ts`: cycle detection (Tarjan), fanout aggregation, orphan
  detection, hotspot scoring.
- Hotspot score = `(fanin + fanout) × log(1 + git_churn_count)`. The
  `git_churn_count` comes from a one-off `git log --name-only --since=...`
  scan cached in a `map_churn` table. Recomputed on `map build`, not on
  every save.

## Open questions

1. **Symbol-level edges**: cheap to record but expensive to maintain (one
   refactor renames thousands of symbols). The schema accommodates them but
   the v0.2 indexer only writes them for *exported* symbols. Internal-only
   calls aren't tracked yet.
2. **Polyglot repos**: a TS project that imports a Python pipeline via
   subprocess is invisible to us. We don't try to solve this in v0.2 —
   the Risk panel will show the TS half and the Python half as disconnected
   subgraphs. Manual cross-language linking is a v0.3 idea.
3. **Generated code**: `dist/`, `build/`, `__generated__/` are ignored via
   `.gitignore`, which is enough for most projects. For projects that
   *commit* generated code, the user adds an explicit
   `[map].ignore_paths` in `.codebuddy/config.json`.

## Performance budget

Target: a 50k-LOC TS monorepo should:

- Full index in under 30 seconds on an M2 MacBook Air.
- Incremental update on a single-file save in under 200ms (parse + write).
- Steady-state memory under 200MB (parser pool + node).
- Watcher CPU under 1% at rest.

These are budgets, not promises. The performance test in
`src/map/__perf__/large-repo.test.ts` runs against a synthetic repo and
fails the build if budgets regress by more than 25%.

## Rejected alternatives

- **dependency-cruiser**: closest existing tool. Rejected because (a) it
  ships as a CLI, not a library — embedding it means shelling out and
  parsing JSON for each query, (b) it doesn't update incrementally,
  (c) we'd have no place to hang AI-generated annotations.
- **madge**: TS/JS only and outputs static graphs. Same problems as
  dependency-cruiser.
- **Language Server Protocol**: gives us type-accurate symbol references but
  requires a running LSP server per language. Operationally heavy. Considered
  as a Phase 9 enhancement for type-aware risk analysis.
- **An in-memory graph (no Postgres)**: would skip the schema work but
  loses durability and means every workspace launch re-parses the world.
  Rejected.

## Definition of done for v0.2

- All three new tables exist on a fresh `codebuddy use`.
- `codebuddy map build` produces a non-empty graph on this repo (CodeBuddy
  itself, ~5000 LOC of TS) in under 5 seconds.
- `map deps src/cli/index.ts` lists every command file the CLI imports.
- `map dependents src/db/repository.ts` lists every consumer.
- `codebuddy claude install` exposes the two map tools to Claude Desktop.
- Performance test passes within budget.
- Unit-test coverage of the indexer ≥ 80% lines.
