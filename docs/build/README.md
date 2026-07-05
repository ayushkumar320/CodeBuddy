# Build Docs

Post-2.0 execution packets derived from the improvements backlog.

Use these when you want a scoped implementation brief instead of picking items
ad hoc from [../improvements.md](../improvements.md). The goal is the same as
the original build docs: tight scope, explicit acceptance criteria, and a clear
verification bar.

Each phase file contains:

- scope derived directly from [../improvements.md](../improvements.md);
- implementation goals;
- exact build targets;
- guardrails and non-goals;
- verification checklist;
- a Codex/Claude execution prompt.

## Phase files

1. [05.1 Correctness Hardening](./05.1-correctness-hardening.md)
2. [05.2 Capture and Sensitivity Hardening](./05.2-capture-and-sensitivity-hardening.md)
3. [05.3 Test Confidence and Recovery](./05.3-test-confidence-and-recovery.md)
4. [05.4 Repo Hygiene and Release Ergonomics](./05.4-repo-hygiene-and-release-ergonomics.md)

## Rules

- complete one phase at a time unless the phase explicitly allows parallel work;
- do not widen scope beyond the listed improvement items;
- keep roadmap work (`N.3`–`N.7`, `R.2`) separate unless the phase explicitly
  calls it in;
- do not silently skip tests or quality gates;
- update the living docs when behavior changes.
