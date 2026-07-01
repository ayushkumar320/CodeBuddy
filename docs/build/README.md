# Build Docs

This folder turns Proposal 04 into phase-by-phase execution packets.

Each phase file contains:

- scope derived directly from [Proposal 04](../proposals/04-automatic-context-engine.md);
- implementation goals;
- exact build targets;
- guardrails and non-goals;
- verification checklist;
- detailed Codex/Claude prompts that begin with a senior-software-developer
  framing and end with a quality gate / completion template.

## Phase files

1. [04.1 Setup Hardening and Trust Checks](./04.1-setup-hardening-and-trust-checks.md)
2. [04.2 Context Bootstrap and Before-Edit Retrieval](./04.2-context-bootstrap-and-before-edit-retrieval.md)
3. [04.3 Background Indexing](./04.3-background-indexing.md)
4. [04.4 Automatic Memory Extraction](./04.4-automatic-memory-extraction.md)
5. [04.5 Token Savings Engine](./04.5-token-savings-engine.md)
6. [04.6 Suggestion Engine](./04.6-suggestion-engine.md)
7. [04.7 Client Workflow Templates](./04.7-client-workflow-templates.md)
8. [04.8 Release Hardening](./04.8-release-hardening.md)

## Usage

Use the phase file as the execution brief for Codex or Claude.

Rules:

- complete one phase at a time unless the phase explicitly allows parallel work;
- do not widen scope beyond the listed build targets;
- do not silently skip tests or quality gates;
- treat Proposal 04 as the source of truth if wording ever drifts.
