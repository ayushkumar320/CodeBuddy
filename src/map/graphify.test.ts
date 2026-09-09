import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGraphifyMap } from "./graphify.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadGraphifyMap", () => {
  it("imports file relationships and normalizes absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", path: join(root, "src", "a.ts") },
          { id: "b", path: "src/b.ts" },
        ],
        edges: [{ source: "a", target: "b", type: "imports" }],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.modules.map((module) => module.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(graph.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "import" }]);
  });

  it("imports the Graphify node-link schema (links/source_file) and skips symbol-local edges", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        directed: false,
        nodes: [
          {
            id: "projects_section",
            label: "Projects",
            source_file: "components/sections/Projects.tsx",
          },
          { id: "projects_grid", label: "Grid", source_file: "components/sections/Projects.tsx" },
          { id: "projects_data", label: "projects", source_file: join(root, "data/projects.ts") },
          { id: "env_var_only", label: "CODEBUDDY_NAMESPACE" },
        ],
        links: [
          { source: "projects_section", target: "projects_data", relation: "imports_from" },
          { source: "projects_section", target: "projects_grid", relation: "contains" },
          { source: "projects_section", target: "env_var_only", relation: "requires_env" },
        ],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.modules.map((module) => module.path)).toEqual([
      "components/sections/Projects.tsx",
      "data/projects.ts",
    ]);
    expect(graph.edges).toEqual([
      {
        from: "components/sections/Projects.tsx",
        to: "data/projects.ts",
        kind: "import",
        symbols: ["projects"],
      },
    ]);
    expect(graph.modules[0]?.imports).toEqual(["data/projects.ts"]);
  });

  it("rejects a graph whose nodes share a single file and yield no relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", source_file: "src/a.ts" },
          { id: "b", source_file: "src/a.ts" },
        ],
        links: [{ source: "a", target: "b", relation: "calls" }],
      }),
    );
    await expect(loadGraphifyMap(join(root, "graph.json"), root)).rejects.toThrow(
      /no usable file relationships/,
    );
  });

  it("rejects a malformed graph file", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(join(root, "graph.json"), "{ not json");
    await expect(loadGraphifyMap(join(root, "graph.json"), root)).rejects.toThrow();
  });

  it("drops documentation and containment relations and keeps dynamic imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "chrome", source_file: "components/providers/Chrome.tsx" },
          { id: "cursor", source_file: "components/ui/Cursor.tsx" },
          { id: "agents_doc", source_file: "AGENTS.md" },
          { id: "gsap", source_file: "lib/gsap.ts" },
        ],
        links: [
          { source: "chrome", target: "cursor", relation: "dynamic_import" },
          { source: "chrome", target: "gsap", relation: "calls" },
          { source: "agents_doc", target: "gsap", relation: "rationale_for" },
        ],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.edges).toEqual([
      {
        from: "components/providers/Chrome.tsx",
        to: "components/ui/Cursor.tsx",
        kind: "dynamic_import",
      },
      { from: "components/providers/Chrome.tsx", to: "lib/gsap.ts", kind: "import" },
    ]);
    // A doc file that merely mentions a module is not one of its importers.
    expect(graph.modules.find((module) => module.path === "AGENTS.md")?.imports).toEqual([]);
  });

  it("prefers a static import over a dynamic one for the same file pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", source_file: "src/a.ts" },
          { id: "b", source_file: "src/b.ts" },
        ],
        links: [
          { source: "a", target: "b", relation: "dynamic_import" },
          { source: "a", target: "b", relation: "imports_from" },
        ],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "import" }]);
  });

  it("swaps endpoints for relations phrased from the dependency's side", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", label: "renderPage()", source_file: "src/a.ts" },
          { id: "b", label: "helper()", source_file: "src/b.ts" },
        ],
        // "b is imported by a": the dependency is the link's source.
        links: [{ source: "b", target: "a", relation: "imported_by" }],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", kind: "import", symbols: ["helper()"] },
    ]);
  });

  it("collects the symbol names a file uses from each dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "page", label: "Page()", source_file: "src/page.tsx" },
          { id: "projects", label: "projects", source_file: "data/projects.ts" },
          { id: "project_type", label: "Project", source_file: "data/projects.ts" },
          // The node standing for the file itself contributes no symbol name.
          { id: "projects_file", label: "data/projects.ts", source_file: "data/projects.ts" },
        ],
        links: [
          { source: "page", target: "projects", relation: "imports_from" },
          { source: "page", target: "project_type", relation: "imports_from" },
          { source: "page", target: "projects_file", relation: "imports" },
        ],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.edges).toEqual([
      {
        from: "src/page.tsx",
        to: "data/projects.ts",
        kind: "import",
        symbols: ["Project", "projects"],
      },
    ]);
  });
});
