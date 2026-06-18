# Multi-Agent Handoff Example

This example should demonstrate one agent remembering a fact and another agent recalling it through `share`.

Target flow:

1. Agent A writes a fact into namespace `research-agent`.
2. Agent A shares the fact to namespace `ops-agent` in `reference` mode.
3. Agent B recalls from `ops-agent` and sees the live shared fact.
4. A second run should show how `snapshot` mode behaves differently.

Key behaviors to show:

- namespace isolation
- reference vs snapshot sharing
- per-agent attribution through `agentId`
- deduplicated writes via `idempotencyKey`

