import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChangeReport, verifyChange } from "./engine.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildChangeReport", () => {
  it("can suppress implicit Git discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-change-"));
    roots.push(root);

    const report = await buildChangeReport({
      repositoryRoot: root,
      namespace: "test",
      useGit: false,
    });

    expect(report.status).toBe("no_changes");
    expect(report.paths).toEqual([]);
  });

  it("composes risk, architecture, and verification signals", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-change-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "core.ts"), "export const core = 1;\n");
    await writeFile(
      join(root, "src", "consumer.ts"),
      'import { core } from "./core.js";\nexport { core };\n',
    );

    const report = await buildChangeReport({
      repositoryRoot: root,
      namespace: "test",
      paths: ["src/core.ts"],
      useGit: false,
    });

    expect(report.paths).toEqual(["src/core.ts"]);
    expect(report.architecture.dependentsByPath["src/core.ts"]).toBe(1);
    expect(report.verification.changedCodeFiles).toEqual(["src/core.ts"]);
    expect(report.status).toBe("review");
    expect(report.architecture.source).toBe("imports");
    expect(report.architecture.warning).toBeUndefined();
  });

  it("uses an explicit Graphify graph for architecture edges", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-change-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "core.ts"), "export const core = 1;\n");
    await writeFile(join(root, "src", "consumer.ts"), "export const consumer = 1;\n");
    const graphPath = join(root, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify({
        nodes: [
          { id: "core", label: "core", source_file: "src/core.ts" },
          { id: "consumer", label: "consumer()", source_file: "src/consumer.ts" },
        ],
        links: [{ source: "consumer", target: "core", relation: "imports_from" }],
      }),
    );

    const report = await buildChangeReport({
      repositoryRoot: root,
      namespace: "test",
      paths: ["src/core.ts"],
      useGit: false,
      graphifyPath: graphPath,
    });

    expect(report.architecture.source).toBe("graphify");
    expect(report.architecture.dependentsByPath["src/core.ts"]).toBe(1);
  });

  it("falls back to the import scan and reports why when the Graphify graph is unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-change-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "core.ts"), "export const core = 1;\n");
    await writeFile(
      join(root, "src", "consumer.ts"),
      'import { core } from "./core.js";\nexport { core };\n',
    );
    const graphPath = join(root, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify({ nodes: [{ id: "a", source_file: "src/core.ts" }] }),
    );

    const report = await buildChangeReport({
      repositoryRoot: root,
      namespace: "test",
      paths: ["src/core.ts"],
      useGit: false,
      graphifyPath: graphPath,
    });

    // The report still lands, and the reason travels with it.
    expect(report.architecture.source).toBe("imports");
    expect(report.architecture.warning).toMatch(/no usable file relationships/);
    expect(report.architecture.dependentsByPath["src/core.ts"]).toBe(1);
  });
});

describe("verifyChange", () => {
  it("runs an explicit verification command and captures its result", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-verify-"));
    roots.push(root);

    const result = await verifyChange({
      repositoryRoot: root,
      namespace: "test",
      useGit: false,
      command: "node -e \"process.stdout.write('verified')\"",
    });

    expect(result.test.status).toBe("passed");
    expect(result.test.source).toBe("explicit");
    expect(result.test.output).toContain("verified");
  });
});
