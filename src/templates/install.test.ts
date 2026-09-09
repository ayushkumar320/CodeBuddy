import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installWorkflowRules, renderManagedBlock, upsertBlock } from "./install.js";
import { renderWorkflowTemplate, WORKFLOW_CLIENTS } from "./workflow.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-rules-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("renderWorkflowTemplate", () => {
  it("references the agent workflow tools and degraded mode for every client", () => {
    for (const client of WORKFLOW_CLIENTS) {
      const text = renderWorkflowTemplate(client);
      for (const tool of [
        "context_pack",
        "context_bootstrap",
        "context_before_edit",
        "context_after_turn",
        "code_suggestions",
      ]) {
        expect(text).toContain(tool);
      }
      expect(text.toLowerCase()).toContain("degraded mode");
    }
  });
});

describe("upsertBlock", () => {
  const block = renderManagedBlock("claude");

  it("creates content when the file is absent", () => {
    expect(upsertBlock(null, block)).toEqual({ content: block, action: "created" });
  });

  it("appends to an existing file without disturbing its content", () => {
    const result = upsertBlock("# My rules\n\nkeep me\n", block);
    expect(result.action).toBe("added");
    expect(result.content.startsWith("# My rules\n\nkeep me\n")).toBe(true);
    expect(result.content).toContain(block.trimEnd());
  });

  it("replaces an existing managed block in place, preserving surrounding text", () => {
    const withBlock = `TOP\n\n${block}\nBOTTOM\n`;
    const updated = renderManagedBlock("codex");
    const result = upsertBlock(withBlock, updated);
    expect(result.action).toBe("updated");
    expect(result.content.startsWith("TOP\n")).toBe(true);
    expect(result.content).toContain("BOTTOM");
    expect(result.content).toContain(updated.trimEnd());
    // The old claude-specific block is gone; only one managed block remains.
    expect(result.content.match(/codebuddy:workflow:start/g)).toHaveLength(1);
  });

  it("reports unchanged when the block is already current", () => {
    const withBlock = upsertBlock(null, block).content;
    expect(upsertBlock(withBlock, block).action).toBe("unchanged");
  });
});

describe("installWorkflowRules", () => {
  it("is idempotent: install then re-install leaves a single managed block", async () => {
    const root = await tempDir();
    const first = await installWorkflowRules({ client: "claude", projectRoot: root });
    expect(first.action).toBe("created");
    expect(first.path.endsWith("CLAUDE.md")).toBe(true);

    const second = await installWorkflowRules({ client: "claude", projectRoot: root });
    expect(second.action).toBe("unchanged");

    const content = await readFile(first.path, "utf8");
    expect(content.match(/codebuddy:workflow:start/g)).toHaveLength(1);
  });

  it("preserves pre-existing rules and honors a custom target path", async () => {
    const root = await tempDir();
    const target = join(root, "AGENTS.md");
    await writeFile(target, "# House rules\n\nAlways be kind.\n", "utf8");

    const result = await installWorkflowRules({ client: "codex", targetPath: target });
    expect(result.action).toBe("added");

    const content = await readFile(target, "utf8");
    expect(content).toContain("Always be kind.");
    expect(content).toContain("context_after_turn");
  });
});
