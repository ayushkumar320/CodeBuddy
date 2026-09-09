import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VERSION } from "../version.js";

export const CODEBUDDY_WORKFLOW_PATH = ".github/workflows/codebuddy.yml";

export type InstallGitHubWorkflowResult = {
  path: string;
  created: boolean;
};

export function renderGitHubWorkflow(version = VERSION): string {
  return `name: CodeBuddy Change Safety

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  codebuddy:
    runs-on: ubuntu-latest
    steps:
      - name: Check out pull request
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install CodeBuddy
        run: npm install --global --no-audit --no-fund @ayushkumar320/codebuddy@${version}

      - name: Generate change report
        run: codebuddy change --json > codebuddy-report.json

      - name: Publish step summary
        env:
          REPORT_PATH: codebuddy-report.json
          SUMMARY_PATH: $GITHUB_STEP_SUMMARY
        run: |
          node <<'NODE'
          const fs = require("fs");
          const report = JSON.parse(fs.readFileSync(process.env.REPORT_PATH, "utf8"));
          const status = report.status.toUpperCase();
          const findings = (report.suggestions || []).slice(0, 8).map((item) =>
            "- **" + item.severity + "** " + item.title + " — " + item.detail,
          );
          const body = [
            "<!-- codebuddy-report -->",
            "## CodeBuddy change report",
            "**Status:** " + status,
            "**Highest risk:** " + report.risk.highestScore + "/100",
            "**Changed paths:** " + report.paths.length,
            "**Direct dependents:** " + report.architecture.totalDependents,
            findings.length ? "\\n### Findings\\n" + findings.join("\\n") : "\\nNo findings.",
          ].join("\\n");
          fs.writeFileSync("codebuddy-report.md", body + "\\n");
          fs.appendFileSync(process.env.SUMMARY_PATH, body + "\\n");
          NODE

      - name: Comment on pull request
        uses: actions/github-script@v7
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
          script: |
            const fs = require("fs");
            const body = fs.readFileSync("codebuddy-report.md", "utf8");
            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const comments = await github.paginate(github.rest.issues.listComments, {
              owner, repo, issue_number, per_page: 100,
            });
            const existing = comments.find((comment) => comment.body?.includes("<!-- codebuddy-report -->"));
            if (existing) {
              await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
            } else {
              await github.rest.issues.createComment({ owner, repo, issue_number, body });
            }
`;
}

export async function installGitHubWorkflow(
  repositoryRoot = process.cwd(),
  options: { force?: boolean } = {},
): Promise<InstallGitHubWorkflowResult> {
  const root = resolve(repositoryRoot);
  const path = join(root, CODEBUDDY_WORKFLOW_PATH);
  if (!options.force) {
    try {
      await access(path, constants.F_OK);
      return { path, created: false };
    } catch {
      // The workflow does not exist yet.
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderGitHubWorkflow(), "utf8");
  return { path, created: true };
}
