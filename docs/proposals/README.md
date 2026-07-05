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
| [04](./04-automatic-context-engine.md) | Automatic Context Engine | Draft | v2.0.0 | @ayushkumar320 |

Shipped proposal docs are removed from this folder once their behavior is
captured in the user/developer docs. Current shipped foundations:

- Storage Model: Markdown-backed facts/summaries, PostgreSQL as derived index.
- Plan Panel: durable Markdown plans with CLI and MCP tools.
- Risk Panel MVP: incident, policy, and Git churn signals with CLI and MCP.
- Architecture Map MVP: lightweight TypeScript/JavaScript import graph with
  CLI and MCP.

## How the proposals fit together

```text
Markdown memory + plans
        │
        ├── risk assess: incidents + policies + Git churn
        │
        └── map query: lightweight TS/JS import graph
```

### Dependency graph between shipped foundations

```text
Markdown memory + plans ──▶ Risk Panel MVP
             │
             └────────────▶ Architecture Map MVP
```

## Execution history

Proposal 04 was implemented in phased packets and is now fully shipped. The
temporary build-packet docs were removed after completion to keep the repo
focused on current behavior and remaining roadmap work.

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
- A graphical desktop renderer.
- Cross-repository analysis.
- Cross-language semantic linking (TS calling Python via subprocess).
