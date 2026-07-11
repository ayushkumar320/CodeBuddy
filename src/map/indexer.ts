import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { ArchitectureMap, MapQuery, ModuleEdge, ModuleNode } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".codebuddy",
]);

export async function buildArchitectureMap(
  repositoryRoot = process.cwd(),
): Promise<ArchitectureMap> {
  const root = resolve(repositoryRoot);
  const files = await listSourceFiles(root);
  const fileSet = new Set(files.map((file) => normalize(relative(root, file))));
  const modules: ModuleNode[] = [];
  const edges: ModuleEdge[] = [];

  for (const absolutePath of files) {
    const source = await readFile(absolutePath, "utf8");
    const from = normalize(relative(root, absolutePath));
    const imports = extractImports(source);
    const resolvedImports: string[] = [];
    for (const specifier of imports) {
      const resolved = resolveImport(root, from, specifier.value, fileSet);
      if (!resolved) continue;
      resolvedImports.push(resolved);
      edges.push({ from, to: resolved, kind: specifier.kind });
    }
    modules.push({
      path: from,
      language: extname(absolutePath).includes("ts") ? "ts" : "js",
      imports: [...new Set(resolvedImports)].sort(),
    });
  }

  return {
    modules: modules.sort((left, right) => left.path.localeCompare(right.path)),
    edges: edges.sort((left, right) =>
      `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
    ),
  };
}

export type IncrementalMapStats = { readFiles: number; reusedFiles: number; rebuilt: boolean };

/** Build or update a map from an already-known source file set. */
export async function updateArchitectureMap(
  repositoryRoot: string,
  sourcePaths: string[],
  previous: ArchitectureMap | null,
  changedPaths: string[],
): Promise<{ map: ArchitectureMap; stats: IncrementalMapStats }> {
  const root = resolve(repositoryRoot);
  const normalizedPaths = sourcePaths.map(normalize).sort();
  const fileSet = new Set(normalizedPaths);
  const changed = new Set(changedPaths.map(normalize));
  const retainedModules = (previous?.modules ?? []).filter(
    (module) => fileSet.has(module.path) && !changed.has(module.path),
  );
  const retainedEdges = (previous?.edges ?? []).filter(
    (edge) => fileSet.has(edge.from) && fileSet.has(edge.to) && !changed.has(edge.from),
  );
  const modules = [...retainedModules];
  const edges = [...retainedEdges];

  for (const path of normalizedPaths) {
    if (!changed.has(path)) continue;
    const source = await readFile(join(root, path), "utf8");
    const imports = extractImports(source);
    const resolvedImports: string[] = [];
    for (const specifier of imports) {
      const resolvedImport = resolveImport(root, path, specifier.value, fileSet);
      if (!resolvedImport) continue;
      resolvedImports.push(resolvedImport);
      edges.push({ from: path, to: resolvedImport, kind: specifier.kind });
    }
    modules.push({
      path,
      language: extname(path).includes("ts") ? "ts" : "js",
      imports: [...new Set(resolvedImports)].sort(),
    });
  }

  return {
    map: {
      modules: modules.sort((left, right) => left.path.localeCompare(right.path)),
      edges: edges.sort((left, right) =>
        `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
      ),
    },
    stats: {
      readFiles: changed.size,
      reusedFiles: retainedModules.length,
      rebuilt: previous === null || changed.size === normalizedPaths.length,
    },
  };
}

export function queryMap(map: ArchitectureMap, query: MapQuery): ModuleEdge[] {
  const limit = query.limit ?? 50;
  return map.edges
    .filter((edge) => (query.from ? edge.from === normalize(query.from) : true))
    .filter((edge) => (query.to ? edge.to === normalize(query.to) : true))
    .slice(0, limit);
}

export function neighbours(
  map: ArchitectureMap,
  modulePath: string,
  direction: "in" | "out" | "both" = "both",
): { modules: ModuleNode[]; edges: ModuleEdge[] } {
  const target = normalize(modulePath);
  const edges = map.edges.filter((edge) => {
    if (direction === "in") return edge.to === target;
    if (direction === "out") return edge.from === target;
    return edge.from === target || edge.to === target;
  });
  const paths = new Set<string>([target]);
  for (const edge of edges) {
    paths.add(edge.from);
    paths.add(edge.to);
  }
  return {
    modules: map.modules.filter((module) => paths.has(module.path)),
    edges,
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files.sort();
}

async function walk(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await walk(absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name))) continue;
    const info = await stat(absolute);
    if (info.size > 500_000) continue;
    files.push(absolute);
  }
}

function extractImports(source: string): Array<{ value: string; kind: ModuleEdge["kind"] }> {
  const imports: Array<{ value: string; kind: ModuleEdge["kind"] }> = [];
  const staticImport = /\bimport\s+(?:type\s+)?(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']/g;
  const exportFrom = /\bexport\s+[^'"()]+?\s+from\s+["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(staticImport)) {
    if (match[1]) imports.push({ value: match[1], kind: "import" });
  }
  for (const match of source.matchAll(exportFrom)) {
    if (match[1]) imports.push({ value: match[1], kind: "import" });
  }
  for (const match of source.matchAll(dynamicImport)) {
    if (match[1]) imports.push({ value: match[1], kind: "dynamic_import" });
  }
  return imports;
}

function resolveImport(
  root: string,
  from: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(relative(root, resolve(root, dirname(from), specifier)));
  // ESM specifiers point at emitted JS (`./x.js`), but the source on disk is
  // `./x.ts`. Strip a trailing JS-style extension so the stem can resolve to
  // its TypeScript/JavaScript source the same way extensionless imports do.
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const bases = stem === base ? [base] : [stem, base];
  const candidates = bases.flatMap((b) => [
    b,
    `${b}.ts`,
    `${b}.tsx`,
    `${b}.js`,
    `${b}.jsx`,
    `${b}.mjs`,
    `${b}.cjs`,
    `${b}/index.ts`,
    `${b}/index.tsx`,
    `${b}/index.js`,
    `${b}/index.jsx`,
  ]);
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
