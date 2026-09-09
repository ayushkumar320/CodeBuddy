import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
  graphPath: string;
  message: string;
};

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
      graphPath: "graphify-out/graph.json",
      message:
        "Graphify was selected but is not available. Install graphifyy with uv/pipx, then run `graphify install`.",
    };
  }

  try {
    await run("graphify", ["install"], options.repositoryRoot);
  } catch {
    // Project MCP configuration below still gives the user a working path.
  }

  return {
    available: true,
    installed,
    graphPath: "graphify-out/graph.json",
    message:
      "Graphify is connected through the project MCP config. Run `/graphify .` in Claude or Codex to build its local graph.",
  };
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

export async function graphifyGraphExists(repositoryRoot: string): Promise<boolean> {
  try {
    await access(join(repositoryRoot, "graphify-out", "graph.json"));
    return true;
  } catch {
    return false;
  }
}
