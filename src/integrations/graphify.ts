import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { writeAtomic } from "../core/markdown-store-fs.js";

const execFileAsync = promisify(execFile);

export type GraphifyCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export type GraphifySetupOptions = {
  repositoryRoot: string;
  run?: GraphifyCommandRunner;
};

export type GraphifySetupResult = {
  available: boolean;
  installed: boolean;
  generated: boolean;
  graphPath: string;
  message: string;
};

export type GenerateGraphifyOptions = {
  repositoryRoot: string;
  graphPath?: string;
  run?: GraphifyCommandRunner;
};

export type GenerateGraphifyResult = {
  graphPath: string;
  generated: boolean;
  nodes: number;
  edges: number;
};

const DEFAULT_GRAPH_PATH = "graphify-out/graph.json";

/** Detect, install, and register Graphify without making it a CodeBuddy dependency. */
export async function setupGraphify(options: GraphifySetupOptions): Promise<GraphifySetupResult> {
  const run = options.run ?? runCommand;
  let available = await commandWorks(run, "graphify", ["--version"], options.repositoryRoot);
  let installed = false;

  if (!available) {
    const installers = [
      ["uv", ["tool", "install", "graphifyy"]],
      ["pipx", ["install", "graphifyy"]],
      ["python", ["-m", "pip", "install", "--user", "graphifyy"]],
    ] as const;
    for (const [command, args] of installers) {
      try {
        await run(command, [...args], options.repositoryRoot);
        available = await commandWorks(run, "graphify", ["--version"], options.repositoryRoot);
        if (available) {
          installed = true;
          break;
        }
      } catch {
        // Try the next supported local installer.
      }
    }
  }

  if (!available) {
    return {
      available: false,
      installed,
      generated: false,
      graphPath: DEFAULT_GRAPH_PATH,
      message:
        "Graphify was selected but is not available. Install graphifyy with uv/pipx, then run `codebuddy graphify index`.",
    };
  }

  try {
    await run("graphify", ["install"], options.repositoryRoot).catch(() => undefined);
    const graph = await generateGraphifyGraph({ repositoryRoot: options.repositoryRoot, run });
    return {
      available: true,
      installed,
      generated: true,
      graphPath: graph.graphPath,
      message: `Graphify graph generated (${graph.nodes} nodes, ${graph.edges} edges).`,
    };
  } catch (error) {
    return {
      available: true,
      installed,
      generated: false,
      graphPath: DEFAULT_GRAPH_PATH,
      message: `Graphify is installed but its graph could not be generated: ${(error as Error).message}`,
    };
  }
}

async function commandWorks(
  run: GraphifyCommandRunner,
  command: string,
  args: string[],
  cwd: string,
): Promise<boolean> {
  try {
    await run(command, args, cwd);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { cwd });
}

export async function graphifyGraphExists(
  repositoryRoot: string,
  graphPath = DEFAULT_GRAPH_PATH,
): Promise<boolean> {
  try {
    const parsed = await readGraphFile(resolveGraphPath(repositoryRoot, graphPath));
    return parsed.nodes > 0;
  } catch {
    return false;
  }
}

/**
 * Build a graph with Graphify itself. Staging is used for first builds and
 * invalid graphs so a failed extractor can never replace a usable graph.
 */
export async function generateGraphifyGraph(
  options: GenerateGraphifyOptions,
): Promise<GenerateGraphifyResult> {
  const run = options.run ?? runCommand;
  const repositoryRoot = resolve(options.repositoryRoot);
  const graphPath = options.graphPath ?? DEFAULT_GRAPH_PATH;
  const destination = resolveGraphPath(repositoryRoot, graphPath);
  await mkdir(dirname(destination), { recursive: true });
  await ignoreGeneratedGraphDirectory(dirname(destination));

  const current = await readGraphFileIfPresent(destination);
  const isDefaultPath = graphPath === DEFAULT_GRAPH_PATH;
  if (current && isDefaultPath) {
    const backup = await readFile(destination, "utf8");
    try {
      await run("graphify", ["update", repositoryRoot, "--force", "--no-cluster"], repositoryRoot);
      const updated = await readGraphFile(destination);
      return { graphPath, generated: true, ...updated };
    } catch (error) {
      await writeAtomic(destination, backup);
      throw new Error(
        `Graphify update failed; the previous graph was preserved: ${(error as Error).message}`,
      );
    }
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
  try {
    await run(
      "graphify",
      ["extract", repositoryRoot, "--out", stagingRoot, "--code-only", "--no-cluster"],
      repositoryRoot,
    );
    const stagedPath = join(stagingRoot, DEFAULT_GRAPH_PATH);
    const staged = await readGraphFile(stagedPath);
    await writeAtomic(destination, await readFile(stagedPath, "utf8"));
    return { graphPath, generated: true, ...staged };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * The graph directory is derived output CodeBuddy writes itself, so it is
 * self-ignoring like `.codebuddy/`. An existing .gitignore is never rewritten:
 * a project that deliberately commits its graph keeps doing so.
 */
async function ignoreGeneratedGraphDirectory(directory: string): Promise<void> {
  const path = join(directory, ".gitignore");
  try {
    await stat(path);
  } catch {
    await writeAtomic(path, "# CodeBuddy-generated Graphify output (derived, rebuildable)\n*\n");
  }
}

function resolveGraphPath(repositoryRoot: string, graphPath: string): string {
  const absolute = resolve(repositoryRoot, graphPath);
  const relativePath = relative(repositoryRoot, absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Graph path must be inside the project root: ${graphPath}`);
  }
  return absolute;
}

async function readGraphFileIfPresent(
  path: string,
): Promise<{ nodes: number; edges: number } | null> {
  try {
    return await readGraphFile(path);
  } catch {
    return null;
  }
}

async function readGraphFile(path: string): Promise<{ nodes: number; edges: number }> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0)
    throw new Error(`Graphify graph is missing or empty: ${path}`);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const nodes = arrayLength(raw.nodes ?? raw.entities);
  const edges = arrayLength(raw.edges ?? raw.links ?? raw.relationships);
  if (nodes === 0) throw new Error(`Graphify graph contains no nodes: ${path}`);
  return { nodes, edges };
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
