import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CLI end-to-end smoke tests. They execute the real entrypoint through tsx in a
 * temp repo and assert exit code + output shape, so command registration, flag
 * wiring, and output regressions are caught without duplicating engine-level
 * coverage. One command per family: file-only (map), risk-style (risk), and a
 * rules template command.
 */

const execFileAsync = promisify(execFile);
const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-cli-"));
  roots.push(root);
  return root;
}

async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, CODEBUDDY_NAMESPACE: "clitest" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI end-to-end", () => {
  it("map build reports module and edge counts as JSON", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "a.ts"),
      'import { b } from "./b.js";\nexport const a = b;\n',
    );
    await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");

    const { code, stdout } = await runCli(["map", "build"], root);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { modules: number; edges: number };
    expect(parsed.modules).toBe(2);
    expect(parsed.edges).toBe(1);
  });

  it("risk assess --json prints a machine-readable assessment", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

    const { code, stdout } = await runCli(
      ["risk", "assess", "--paths", "src/a.ts", "--json"],
      root,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty("items");
  });

  it("rules show prints the workflow template", async () => {
    const root = await tempRepo();
    const { code, stdout } = await runCli(["rules", "show"], root);
    expect(code).toBe(0);
    expect(stdout).toContain("codebuddy");
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("exits non-zero on an unknown command", async () => {
    const root = await tempRepo();
    const { code } = await runCli(["definitely-not-a-command"], root);
    expect(code).not.toBe(0);
  });
});
