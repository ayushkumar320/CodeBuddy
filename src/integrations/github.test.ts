import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEBUDDY_WORKFLOW_PATH, installGitHubWorkflow, renderGitHubWorkflow } from "./github.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitHub workflow integration", () => {
  it("renders a pinned, sticky-comment workflow", () => {
    const workflow = renderGitHubWorkflow("9.9.9");
    expect(workflow).toContain("@ayushkumar320/codebuddy@9.9.9");
    expect(workflow).toContain("<!-- codebuddy-report -->");
    expect(workflow).toContain("actions/github-script@v7");
  });

  it("installs idempotently unless forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-github-"));
    roots.push(root);
    const first = await installGitHubWorkflow(root);
    const second = await installGitHubWorkflow(root);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readFile(join(root, CODEBUDDY_WORKFLOW_PATH), "utf8")).toContain(
      "CodeBuddy Change Safety",
    );
  });
});
