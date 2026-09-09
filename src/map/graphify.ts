import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ArchitectureMap, ModuleEdge, ModuleNode } from "./types.js";

type GraphifyRecord = Record<string, unknown>;

/**
 * Graphify emits containment and documentation relations alongside real
 * dependencies. Keeping them would make a README or an MCP config look like an
 * importer of the code it mentions, so they are dropped. Edges with no relation
 * field (older graph.json exports) are still treated as imports.
 */
const NON_DEPENDENCY_RELATIONS = new Set([
  "contains",
  "part_of",
  "defines",
  "declares",
  "references",
  "requires_env",
  "rationale_for",
]);

/**
 * Graphify's graph is undirected, so a relation phrased from the dependency's
 * point of view ("b is imported by a") arrives with its endpoints the wrong way
 * round for a dependency edge. These are swapped rather than dropped.
 */
const INVERSE_RELATIONS = new Set([
  "imported_by",
  "called_by",
  "used_by",
  "referenced_by",
  "extended_by",
  "implemented_by",
  "dependency_of",
  "depended_on_by",
]);

/** How many symbol names an edge carries, so a large fan-in stays bounded. */
const MAX_EDGE_SYMBOLS = 8;

/** Import the common graph.json node/edge shape without depending on Graphify. */
export async function loadGraphifyMap(
  graphPath: string,
  repositoryRoot = process.cwd(),
): Promise<ArchitectureMap> {
  const raw = JSON.parse(await readFile(graphPath, "utf8")) as GraphifyRecord;
  const nodes = arrayRecord(raw.nodes ?? raw.entities);
  const edges = arrayRecord(raw.edges ?? raw.links ?? raw.relationships);
  const nodePaths = new Map<string, string>();
  const nodeLabels = new Map<string, string>();
  const modules: ModuleNode[] = [];

  for (const node of nodes) {
    const id = stringValue(node.id ?? node.key ?? node.name);
    const path = graphifyPath(node, repositoryRoot);
    if (!id || !path) continue;
    nodePaths.set(id, path);
    const label = stringValue(node.label ?? node.name);
    // The node standing for the file itself carries no useful symbol name.
    if (label && label !== path && !path.endsWith(`/${label}`)) nodeLabels.set(id, label);
    modules.push({ path, language: languageFor(path), imports: [] });
  }

  const modulePaths = new Set(modules.map((module) => module.path));
  const importedEdges: ModuleEdge[] = [];
  for (const edge of edges) {
    const relation = stringValue(edge.relation ?? edge.type ?? edge.kind)?.toLowerCase() ?? null;
    if (relation && NON_DEPENDENCY_RELATIONS.has(relation)) continue;
    const inverse = relation !== null && INVERSE_RELATIONS.has(relation);
    const sourceEndpoint = edge.from ?? edge.source;
    const targetEndpoint = edge.to ?? edge.target;
    const [tail, head] = inverse
      ? [targetEndpoint, sourceEndpoint]
      : [sourceEndpoint, targetEndpoint];
    const from = endpointPath(tail, nodePaths, repositoryRoot);
    const to = endpointPath(head, nodePaths, repositoryRoot);
    if (!from || !to || !modulePaths.has(from) || !modulePaths.has(to) || from === to) continue;
    // The endpoint inside the dependency names the symbol the dependant uses.
    const symbol = endpointLabel(head, nodeLabels);
    importedEdges.push({
      from,
      to,
      kind: relation?.includes("dynamic") ? "dynamic_import" : "import",
      ...(symbol ? { symbols: [symbol] } : {}),
    });
  }

  const uniqueModules = [...new Map(modules.map((module) => [module.path, module])).values()].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const byEndpoints = new Map<string, ModuleEdge>();
  for (const edge of importedEdges) {
    const key = `${edge.from}:${edge.to}`;
    const existing = byEndpoints.get(key);
    if (!existing) {
      byEndpoints.set(key, edge);
      continue;
    }
    // Several symbol-level links collapse into one file edge: keep every symbol
    // name, and let a static import win over a dynamic one.
    const symbols = mergeSymbols(existing.symbols, edge.symbols);
    byEndpoints.set(key, {
      ...(existing.kind === "dynamic_import" && edge.kind === "import" ? edge : existing),
      ...(symbols ? { symbols } : {}),
    });
  }
  const uniqueEdges = [...byEndpoints.values()].sort((left, right) =>
    `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
  );
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

function endpointLabel(endpoint: unknown, nodeLabels: Map<string, string>): string | null {
  if (typeof endpoint === "string") return nodeLabels.get(endpoint) ?? null;
  if (!endpoint || typeof endpoint !== "object") return null;
  const id = stringValue((endpoint as GraphifyRecord).id);
  return id ? (nodeLabels.get(id) ?? null) : null;
}

function mergeSymbols(left?: string[], right?: string[]): string[] | undefined {
  if (!left && !right) return undefined;
  return [...new Set([...(left ?? []), ...(right ?? [])])].sort().slice(0, MAX_EDGE_SYMBOLS);
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
