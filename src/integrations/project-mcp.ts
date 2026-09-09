import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeAtomic } from "../core/markdown-store-fs.js";

export type ProjectMcpServer = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ProjectMcpConfig = {
  mcpServers?: Record<string, ProjectMcpServer>;
};

export type WriteProjectMcpConfigOptions = {
  repositoryRoot: string;
  namespace: string;
  graphify: boolean;
  graphPath?: string;
};

/** Add CodeBuddy and, optionally, Graphify to the project's MCP config. */
export async function writeProjectMcpConfig(
  options: WriteProjectMcpConfigOptions,
): Promise<{ path: string; servers: string[] }> {
  const path = join(options.repositoryRoot, ".mcp.json");
  const current = await readProjectMcpConfig(path);
  current.mcpServers ??= {};
  current.mcpServers[`codebuddy-${options.namespace}`] = {
    command: "codebuddy",
    args: ["serve"],
    env: {
      CODEBUDDY_PROJECT_ROOT: options.repositoryRoot,
      CODEBUDDY_NAMESPACE: options.namespace,
    },
  };
  if (options.graphify) {
    current.mcpServers.graphify = {
      command: "python",
      args: [
        "-m",
        "graphify.serve",
        resolve(options.repositoryRoot, options.graphPath ?? "graphify-out/graph.json"),
      ],
      env: { CODEBUDDY_PROJECT_ROOT: options.repositoryRoot },
    };
  } else if (current.mcpServers.graphify) {
    delete current.mcpServers.graphify;
  }
  await writeAtomic(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 });
  return { path, servers: Object.keys(current.mcpServers).sort() };
}

async function readProjectMcpConfig(path: string): Promise<ProjectMcpConfig> {
  try {
    await access(path);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ProjectMcpConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
}
