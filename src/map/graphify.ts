import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ArchitectureMap, ModuleEdge, ModuleNode } from "./types.js";

type GraphifyRecord = Record<string, unknown>;

/** Import the common graph.json node/edge shape without depending on Graphify. */
export async function loadGraphifyMap(
  graphPath: string,
  repositoryRoot = process.cwd(),
): Promise<ArchitectureMap> {
  const raw = JSON.parse(await readFile(graphPath, "utf8")) as GraphifyRecord;
  const nodes = arrayRecord(raw.nodes ?? raw.entities);
  const edges = arrayRecord(raw.edges ?? raw.relationships);
  const nodePaths = new Map<string, string>();
  const modules: ModuleNode[] = [];

  for (const node of nodes) {
    const id = stringValue(node.id ?? node.key ?? node.name);
    const path = graphifyPath(node, repositoryRoot);
    if (!id || !path) continue;
    nodePaths.set(id, path);
    modules.push({ path, language: languageFor(path), imports: [] });
  }

  const modulePaths = new Set(modules.map((module) => module.path));
  const importedEdges: ModuleEdge[] = [];
  for (const edge of edges) {
    const from = endpointPath(edge.from ?? edge.source, nodePaths, repositoryRoot);
    const to = endpointPath(edge.to ?? edge.target, nodePaths, repositoryRoot);
    if (!from || !to || !modulePaths.has(from) || !modulePaths.has(to) || from === to) continue;
    importedEdges.push({ from, to, kind: "import" });
  }

  const uniqueModules = [...new Map(modules.map((module) => [module.path, module])).values()].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const uniqueEdges = [
    ...new Map(importedEdges.map((edge) => [`${edge.from}:${edge.to}`, edge])).values(),
  ].sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`));
  if (uniqueModules.length === 0 || uniqueEdges.length === 0) {
    throw new Error(`Graphify graph contains no usable file relationships: ${graphPath}`);
  }
  for (const module of uniqueModules) {
    module.imports = uniqueEdges
      .filter((edge) => edge.from === module.path)
      .map((edge) => edge.to)
      .sort();
  }
  return { modules: uniqueModules, edges: uniqueEdges };
}

function arrayRecord(value: unknown): GraphifyRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is GraphifyRecord => Boolean(item && typeof item === "object"))
    : [];
}

function endpointPath(
  endpoint: unknown,
  nodePaths: Map<string, string>,
  repositoryRoot: string,
): string | null {
  if (typeof endpoint === "string")
    return nodePaths.get(endpoint) ?? normalizeGraphPath(endpoint, repositoryRoot);
  if (!endpoint || typeof endpoint !== "object") return null;
  const record = endpoint as GraphifyRecord;
  const id = stringValue(record.id ?? record.key ?? record.name);
  return nodePaths.get(id ?? "") ?? graphifyPath(record, repositoryRoot);
}

function graphifyPath(node: GraphifyRecord, repositoryRoot: string): string | null {
  const source = node.source;
  const location = node.location;
  const candidate =
    stringValue(node.path ?? node.file ?? node.file_path ?? node.source_file) ??
    (source && typeof source === "object" ? stringValue((source as GraphifyRecord).path) : null) ??
    (location && typeof location === "object"
      ? stringValue((location as GraphifyRecord).file ?? (location as GraphifyRecord).path)
      : null);
  return candidate ? normalizeGraphPath(candidate, repositoryRoot) : null;
}

function normalizeGraphPath(path: string, repositoryRoot: string): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
  const relativePath = relative(resolve(repositoryRoot), absolute).replace(/\\/g, "/");
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../")) return null;
  return relativePath.replace(/^\.\//, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function languageFor(path: string): "ts" | "js" {
  return /\.tsx?$/.test(path) ? "ts" : "js";
}
