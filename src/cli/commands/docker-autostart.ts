import { spawn } from "node:child_process";

/**
 * `docker info` exits 0 when the daemon is reachable, non-zero otherwise.
 */
export async function isDockerDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Try to start Docker Desktop on macOS. No-op on other platforms because
 * Linux Docker is typically a system service the user has to manage.
 */
export async function tryStartDockerDesktop(): Promise<{ started: boolean }> {
  if (process.platform !== "darwin") return { started: false };
  return new Promise((resolve) => {
    const child = spawn("open", ["-ga", "Docker"], { stdio: "ignore" });
    child.on("error", () => resolve({ started: false }));
    child.on("close", (code) => resolve({ started: code === 0 }));
  });
}

/**
 * Wait up to `timeoutMs` for the Docker daemon to accept connections.
 * Polls `docker info` every second. Returns true if it came up in time.
 */
export async function waitForDockerDaemon(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDockerDaemonRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
