# Proposals

This folder holds design documents for features under consideration or in
flight. Each file is a self-contained RFC: problem statement, goals,
non-goals, schema, phased execution plan, open questions, rejected
alternatives, and a precise definition of done.

Proposals here describe *what to build and why*, not implementation status.
The status field at the top of each doc moves through: Draft → Accepted →
In Progress → Shipped → Superseded.

## Active proposals

| # | Title | Status | Target | Owner |
|---|---|---|---|---|
| [00](./00-storage-model.md) | Storage Model (markdown-first, DB as derived index) | Draft | v0.2.0 | @ayushkumar320 |
| [01](./01-architecture-map.md) | Architecture Map | Draft | v0.2.0 | @ayushkumar320 |
| [02](./02-plan-panel.md) | Plan Panel | Draft (revised — markdown-first) | v0.2.0 | @ayushkumar320 |
| [03](./03-risk-panel.md) | Risk Panel | Draft | v0.2.0 | @ayushkumar320 |

**Read 00 first.** It establishes the markdown-first storage decision that
01, 02, and 03 all depend on. Without 00 the others are still readable but
the file/database split they reference will be confusing.

## How the three fit together

```
┌────────────────────────────────────────────────────────────────────┐
│                       v0.2 Workspace surface                       │
├──────────────┬────────────────────────────────┬────────────────────┤
│  Plan Panel  │      Architecture Map          │    Risk Panel      │
│              │                                │                    │
│ structured   │ tree-sitter parsed module      │ joins the map,     │
│ spec of      │ graph, refreshed on save,      │ git churn, memory  │
│ what the     │ persisted in Postgres          │ incidents, type    │
│ agent will   │                                │ failures, policy   │
│ do          │ exposes:                       │ rules.             │
│              │  - codebuddy map               │                    │
│ exposes:     │  - mcp__codebuddy_map_*        │ exposes:           │
│  - codebuddy │                                │  - codebuddy risk  │
│    plan      │                                │  - mcp__codebuddy_ │
│  - mcp__     │                                │    risk_assess     │
│    plan_*    │                                │                    │
├──────────────┴────────────────────────────────┴────────────────────┤
│                                                                    │
│                  Existing CodeBuddy primitives                     │
│        (memory, namespaces, share, MCP server, CLI)                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Dependency graph between proposals

```
00 Storage Model ──▶ 01 Architecture Map ─┬─▶ 03 Risk Panel
                ───▶ 02 Plan Panel ───────┘
```

- **00 Storage Model** is the architectural decision the other three sit on
  top of. Markdown is the source of truth; Postgres is a derived index.
  Read this first; otherwise the table/file split in 01–03 looks arbitrary.
- **01 Architecture Map** is the foundation for graph queries. It can ship
  alone; nothing blocks it.
- **02 Plan Panel** can ship alone. It is independent of 01. When 01 is
  available, the plan generator may consult the map to suggest
  `filesToTouch`, but the panel works without it.
- **03 Risk Panel** is the consumer. It requires both 01 (for the
  call-graph blast-radius signal) and 02 (for the change-set input). If
  shipped before 01 or 02, it works in a degraded mode that uses only
  git churn, memory incidents, and policy rules.

## Execution order

Recommended order for a solo developer working on this:

0. Implement **00 Storage Model** first. Shifts memory + plans onto the
   filesystem, repoints `embeddings` at file paths, ships a
   `codebuddy reindex` command and a `codebuddy migrate to-files`
   migration for existing v0.1 installs.
   Estimated: 1 week.
1. Land **02 Plan Panel** next. With 00 in place, plans are just one
   more markdown surface. Ships the most visible UX shift
   (plans-as-artefacts instead of chat).
   Estimated: 1 week.
2. Land **01 Architecture Map** next. Larger, but unlocks 03 and pays
   for itself on every future feature that needs the graph.
   Estimated: 3 weeks.
3. Land **03 Risk Panel** last. Smallest implementation effort because
   it composes signals from the other two and from existing memory.
   Estimated: 1 week.

Total: ~6 weeks for the v0.2 workspace foundation.

## Conventions for new proposals

When opening a new proposal:

- Number it sequentially (`NN-slug.md`).
- Set `Status: Draft` at the top with date.
- Mandatory sections: Why this exists, Goals, Non-goals,
  User-visible behaviour, Architecture, Implementation phases,
  Rejected alternatives, Definition of done.
- Avoid prose that justifies the feature in marketing terms. The
  audience is a future contributor (possibly you in three months)
  trying to understand why the code is the shape it is.
- If a proposal changes substantially after acceptance, supersede it
  with a new file rather than rewriting history. The old file moves
  to `Status: Superseded by NN`.

## Out of scope for v0.2

Captured here so future proposals don't accidentally re-invent them:

- Type-aware analysis (LSP integration). Listed as a follow-up to 01.
- Plan branching (multiple parallel plans). Listed in 02.
- ML-based risk scoring. Listed in 03.
- A graphical desktop renderer. Pulled out into a separate future
  proposal (`05-workspace-ui`) so 01-03 can ship and be validated
  through CLI and MCP first.
- Cross-repository analysis.
- Cross-language semantic linking (TS calling Python via subprocess).
