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
| [01](./01-architecture-map.md) | Architecture Map | Deferred/gated | v0.2.x | @ayushkumar320 |
| [03](./03-risk-panel.md) | Risk Panel | In Progress | v0.2.x | @ayushkumar320 |

Shipped proposal docs are removed from this folder once their behavior is
captured in the user/developer docs. Current shipped foundations:

- Storage Model: Markdown-backed facts/summaries, PostgreSQL as derived index.
- Plan Panel: durable Markdown plans with CLI and MCP tools.

## How the proposals fit together

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
Implemented storage + plans ──▶ 03 Risk Panel
                         01 Architecture Map ──▶ optional blast-radius signal
```

- **03 Risk Panel** consumes plans and memory incidents first. It can ship
  without 01 by using policy, Git churn, and structured incident memory.
- **01 Architecture Map** is optional for the first Risk MVP. It becomes
  valuable if blast-radius evidence is frequently missing.

## Execution order

Recommended order from the current codebase:

1. Finish **03 Risk Panel** without blast-radius analysis. It composes
   policy rules, Git churn, and structured incident memory.
   Estimated: 1 week.
2. Evaluate **01 Architecture Map** only if Risk MVP shows that dependency
   blast radius is needed often enough to justify the parser work.
   Estimated: 3 weeks if accepted.

Total: ~1 week for Risk MVP, plus the optional Architecture Map experiment.

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

- Type-aware analysis (LSP integration).
- Plan branching (multiple parallel plans).
- ML-based risk scoring.
- A graphical desktop renderer. Pulled out into a separate future
  proposal (`05-workspace-ui`) so 01-03 can ship and be validated
  through CLI and MCP first.
- Cross-repository analysis.
- Cross-language semantic linking (TS calling Python via subprocess).
