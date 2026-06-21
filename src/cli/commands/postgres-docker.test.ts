import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { resolveBundledComposeFile, runDockerCompose } from "./postgres-docker.js";

function fakeChild(
  opts: { code?: number; stdout?: string; stderr?: string; emitError?: NodeJS.ErrnoException } = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (opts.emitError) {
      child.emit("error", opts.emitError);
      return;
    }
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

describe("resolveBundledComposeFile", () => {
  it("finds the docker-compose.yml at the repo root", () => {
    const path = resolveBundledComposeFile();
    expect(path).toMatch(/docker-compose\.yml$/);
  });
});

describe("runDockerCompose", () => {
  it("uses docker compose v2 when available", async () => {
    const spawnImpl = vi.fn(() => fakeChild({ stdout: "Container codebuddy-postgres Started\n" }));
    const result = await runDockerCompose(["up", "-d"], {
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Started");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const firstArgs = (spawnImpl.mock.calls[0] as unknown as [string, string[]])[1];
    expect(firstArgs[0]).toBe("compose");
  });

  it("falls back to docker-compose v1 when v2 spawn fails ENOENT", async () => {
    const v2Error: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
      code: "ENOENT",
    });
    const spawnImpl = vi
      .fn()
      .mockImplementationOnce(() => fakeChild({ emitError: v2Error }))
      .mockImplementationOnce(() => fakeChild({ stdout: "v1 ok\n" }));
    const result = await runDockerCompose(["up"], {
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    const calls = spawnImpl.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls[0]?.[0]).toBe("docker");
    expect(calls[1]?.[0]).toBe("docker-compose");
    expect(result.stdout).toContain("v1 ok");
  });

  it("throws a helpful error when neither docker nor docker-compose exist", async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
      code: "ENOENT",
    });
    const spawnImpl = vi.fn(() => fakeChild({ emitError: enoent }));
    await expect(
      runDockerCompose(["up"], {
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
      }),
    ).rejects.toThrow(/Install Docker/i);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("propagates non-ENOENT spawn errors without trying the next attempt", async () => {
    const eacces: NodeJS.ErrnoException = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const spawnImpl = vi.fn(() => fakeChild({ emitError: eacces }));
    await expect(
      runDockerCompose(["up"], {
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
      }),
    ).rejects.toThrow(/permission denied/);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("returns non-zero exit codes from docker compose", async () => {
    const spawnImpl = vi.fn(() => fakeChild({ code: 1, stderr: "service postgres failed\n" }));
    const result = await runDockerCompose(["up", "-d"], {
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("service postgres failed");
  });
});
