import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledComposeFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "docker-compose.yml"),
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

export async function runDockerCompose(args: string[]): Promise<DockerComposeResult> {
  const composeFile = resolveBundledComposeFile();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["compose", "-f", composeFile, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      rejectPromise(
        new Error(`Failed to spawn docker. Is Docker installed and running? (${error.message})`),
      );
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

export async function postgresUp(): Promise<DockerComposeResult> {
  return runDockerCompose(["up", "-d"]);
}

export async function postgresDown(): Promise<DockerComposeResult> {
  return runDockerCompose(["down"]);
}

export async function postgresStatus(): Promise<DockerComposeResult> {
  return runDockerCompose(["ps"]);
}
