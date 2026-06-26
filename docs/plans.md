# Plans

CodeBuddy plans are durable Markdown artifacts under `.codebuddy/plans/`.
They capture *what an agent is about to do* — goal, approach, files to touch,
tests to add, risks — as a reviewable, versioned document instead of as
ephemeral chat. Git is the version history; if a database is present it only
holds a derived index, never the source of truth.

## Lifecycle

```
draft ──approve──▶ approved ──start──▶ executing ──complete──▶ complete
  │                   │                    │
  └──────abandon──────┴────────────────────┴────────▶ abandoned
```

At most one plan per namespace is `approved` or `executing` at a time
("active"). Approving a second plan while one is active is refused.

`draft` and `executing` plans can be amended; terminal states cannot.

## CLI

```bash
codebuddy plan new "Add OAuth login flow"   # create a draft, opens $EDITOR
codebuddy plan list                         # active drafts (use --all for closed)
codebuddy plan show <id>                     # render a plan
codebuddy plan edit <id>                     # re-open in $EDITOR, validate on save

codebuddy plan approve <id>                  # draft → approved
codebuddy plan start <id>                    # approved → executing
codebuddy plan complete <id> --commit <sha>  # executing → complete
codebuddy plan abandon <id> --reason "..."   # → abandoned

codebuddy plan diff <id>                      # git diff of the plan file
```

Plan commands are file-based and do **not** require a database connection.
The namespace is resolved from `CODEBUDDY_NAMESPACE`, then
`.codebuddy/config.json`, then the folder name.

## MCP tools

When CodeBuddy runs as an MCP server, agents see four plan tools:

| Tool | Purpose |
|---|---|
| `plan_current` | The active plan for this namespace (or null) plus the policy mode. |
| `plan_create` | Create a draft plan. |
| `plan_amend` | Amend a draft or executing plan's content fields. |
| `plan_status` | Transition a plan (`approved`, `executing`, `complete`, `abandoned`). |

`plan_current` is the load-bearing one: an agent calls it at the top of a
turn so intent survives context resets.

## Policy modes

`codebuddy plan policy [off | suggest | required]` reads or sets how strongly
CodeBuddy steers agents toward planning. Stored in `.codebuddy/config.json`
under `plan.policy`; overridable with `CODEBUDDY_PLAN_POLICY`.

| Mode | Behaviour |
|---|---|
| `off` | Plans are never suggested or required. |
| `suggest` | Agents are reminded to plan, but small tasks stay lightweight. **(default)** |
| `required` | Agents should refuse substantive changes without an active plan. |

The default is `suggest` so trivial work is never blocked while sensitive
projects can opt into `required`.

## Optional system-prompt integration

To make an agent actually use plans, add a snippet like this to your MCP
client's system prompt or rules file:

```text
At the start of a turn that will change code, call plan_current.
- If a plan exists, work against its goal, approach, and filesToTouch.
- If none exists and the plan policy is "required", create one with
  plan_create and ask the developer to approve it before editing.
- If the policy is "suggest", offer to draft a plan for non-trivial work.
```

CodeBuddy does not enforce this itself in v0.2 — enforcement lives in the
agent's instructions. The `policy` field returned by `plan_current` tells the
agent which mode is active.
