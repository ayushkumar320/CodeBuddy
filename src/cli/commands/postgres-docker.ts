import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ComposeCommand =
  | { kind: "v2"; bin: "docker"; args: string[] }
  | { kind: "v1"; bin: "docker-compose"; args: string[] };

export function resolveBundledComposeFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Candidates are ordered most-specific first so a published package's bundled
  // file wins over a stray docker-compose.yml in the user's cwd.
  const candidates = [
    // installed package: dist/cli/commands/ -> root
    resolve(here, "..", "..", "..", "docker-compose.yml"),
    // source layout:    src/cli/commands/ -> root
    resolve(here, "..", "..", "..", "..", "docker-compose.yml"),
    resolve(here, "..", "..", "docker-compose.yml"),
    resolve(process.cwd(), "docker-compose.yml"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate docker-compose.yml. Looked in:\n  ${candidates.join("\n  ")}`);
}

export type DockerComposeResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunDockerComposeOptions = {
  /** Override spawn for tests. */
  spawnImpl?: typeof spawn;
};

/**
 * Try `docker compose` (v2 — bundled with Docker Desktop) first, then fall back
 * to the legacy standalone `docker-compose` (v1) for older installs.
 */
export async function runDockerCompose(
  args: string[],
  options: RunDockerComposeOptions = {},
): Promise<DockerComposeResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const composeFile = resolveBundledComposeFile();
  const attempts: ComposeCommand[] = [
    { kind: "v2", bin: "docker", args: ["compose", "-f", composeFile, ...args] },
    { kind: "v1", bin: "docker-compose", args: ["-f", composeFile, ...args] },
  ];

  let lastSpawnError: NodeJS.ErrnoException | null = null;

  for (const attempt of attempts) {
    try {
      return await spawnOnce(spawnImpl, attempt);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // ENOENT means the binary isn't on PATH — try the next candidate.
      // Any other error is propagated immediately.
      if (err.code !== "ENOENT") throw err;
      lastSpawnError = err;
    }
  }

  throw new Error(
    `Could not find docker. Install Docker Desktop (or docker-compose v1) and ensure it is on your PATH. (${lastSpawnError?.message ?? "spawn ENOENT"})`,
  );
}

function spawnOnce(
  spawnImpl: typeof spawn,
  attempt: ComposeCommand,
): Promise<DockerComposeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(attempt.bin, attempt.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

export async function postgresUp(options?: RunDockerComposeOptions): Promise<DockerComposeResult> {
  return runDockerCompose(["up", "-d"], options ?? {});
}

export async function postgresDown(
  options?: RunDockerComposeOptions,
): Promise<DockerComposeResult> {
  return runDockerCompose(["down"], options ?? {});
}

export async function postgresStatus(
  options?: RunDockerComposeOptions,
): Promise<DockerComposeResult> {
  return runDockerCompose(["ps"], options ?? {});
}
