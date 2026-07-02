/**
 * Client workflow templates (Proposal 04 Phase 04.7). These are the concrete
 * rules that make CodeBuddy's automatic context flow reliable in Claude Code and
 * Codex: they say exactly which MCP tool to call, when, and what to do when a
 * tool or service is unavailable. The text references only tools that actually
 * ship (04.2–04.6): context_bootstrap, context_before_edit, context_after_turn,
 * code_suggestions.
 *
 * Templates are installed into a client's Markdown rules file inside a clearly
 * delimited managed block (see `install.ts`) so updates are idempotent and the
 * user can always see exactly what CodeBuddy added.
 */

export const WORKFLOW_CLIENTS = ["claude", "codex"] as const;
export type WorkflowClient = (typeof WORKFLOW_CLIENTS)[number];

const CLIENT_META: Record<WorkflowClient, { name: string; file: string }> = {
  claude: { name: "Claude Code", file: "CLAUDE.md" },
  codex: { name: "Codex", file: "AGENTS.md" },
};

/** The shared body — identical guidance regardless of client. */
const WORKFLOW_BODY = [
  "You have CodeBuddy available as a local, MCP-backed project-context engine.",
  "Use it to work like a careful senior engineer, not to dump broad context.",
  "",
  "## At the start of a substantive coding turn",
  "",
  "1. Call `context_bootstrap` to load project identity, the active plan and plan",
  "   policy, incident hotspots, and a compact architecture summary.",
  "2. If the task may change files, call `context_before_edit` with the planned",
  "   `paths` (or a `planId`, or `useGit: true`). Read the returned plan, matching",
  "   policy rules, incident memory, risk assessment, and import neighbours before",
  "   deciding what to edit.",
  "",
  "## While implementing",
  "",
  "- Prefer the smallest sufficient set of edits; preserve existing behavior.",
  "- Honor risk warnings and policy rules for the files you touch; call out risk",
  "  before editing sensitive areas.",
  "- Do not re-request broad context if the bootstrap answer already suffices.",
  "",
  "## Before finalizing",
  "",
  "- Consider calling `code_suggestions` (with `paths`, `planId`, or `useGit`) for",
  "  read-only, evidence-backed quality findings; resolve high-severity ones.",
  "- Run the smallest relevant verification (tests, lint, typecheck) and fix",
  "  failures before presenting completion.",
  "",
  "## After a meaningful turn",
  "",
  "- Call `context_after_turn` with a concise `summary`, the `changedFiles`, and a",
  "  `planId` if one is active. CodeBuddy auto-saves confident facts, decisions,",
  "  and incidents, queues uncertain or sensitive items for review, and drops",
  "  chatter. Never paste secrets, tokens, or credentials into the summary.",
  "",
  "## If a tool or service is unavailable (degraded mode)",
  "",
  "- A CodeBuddy MCP tool errors or is missing: proceed using the repository",
  "  itself as the source of truth; do not block on it.",
  "- Postgres is unreachable: the file-based tools (context, plan, risk, map,",
  "  suggest) still work; recall and embeddings may be degraded — say so instead",
  "  of inventing remembered facts.",
  "- Retrieval returns no context: read the relevant files directly rather than",
  "  guessing; the working tree is authoritative.",
  "",
  "## Never",
  "",
  "- Invent behavior the codebase does not support.",
  "- Ignore failing tests or lint.",
  "- Make speculative, wide changes without evidence.",
  "- Save low-confidence project memory as a durable fact.",
].join("\n");

/** Render the full template for a client (heading + shared body). */
export function renderWorkflowTemplate(client: WorkflowClient): string {
  const meta = CLIENT_META[client];
  return [
    `# CodeBuddy workflow (${meta.name})`,
    "",
    `This section is managed by CodeBuddy (\`codebuddy rules install --client ${client}\`)`,
    `and lives in \`${meta.file}\`. Edit outside the managed markers to customize.`,
    "",
    WORKFLOW_BODY,
  ].join("\n");
}

export function defaultRulesFile(client: WorkflowClient): string {
  return CLIENT_META[client].file;
}

export function clientDisplayName(client: WorkflowClient): string {
  return CLIENT_META[client].name;
}
