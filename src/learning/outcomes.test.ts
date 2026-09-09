import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChangeReport } from "../change/engine.js";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { recordChangeOutcome } from "./outcomes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recordChangeOutcome", () => {
  it("turns a regression into future path-specific incident risk", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-learning-"));
    roots.push(root);
    const recorded = await recordChangeOutcome({
      repositoryRoot: root,
      namespace: "team",
      outcome: "regression",
      paths: ["src/auth.ts"],
      summary: "Callback state was dropped after the refactor.",
    });

    expect(recorded.category).toBe("incident");
    expect(await new MemoryFileStore(root).listIncidentFacts({ namespace: "team" })).toHaveLength(
      1,
    );
    const report = await buildChangeReport({
      repositoryRoot: root,
      namespace: "team",
      paths: ["src/auth.ts"],
      useGit: false,
    });
    expect(report.risk.highestScore).toBeGreaterThanOrEqual(80);
    expect(report.status).toBe("blocked");
  });
});
