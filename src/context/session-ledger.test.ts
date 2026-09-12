import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCapsuleLedger } from "./session-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codebuddy-ledger-"));
  roots.push(path);
  return path;
}

describe("SessionCapsuleLedger", () => {
  it("sends once, references unchanged content, and invalidates only changes", async () => {
    const repo = await root();
    const ledger = new SessionCapsuleLedger(repo);
    const capsules = [
      { key: "plan", text: "plan: OAuth callback implementation and rollout" },
      { key: "policy", text: "policy: review auth changes with security checklist" },
    ];
    expect((await ledger.deliver("s1", capsules)).full).toBe(2);
    const repeated = await ledger.deliver("s1", capsules);
    expect(repeated.referenced).toBe(2);
    expect(repeated.avoidedTokens).toBeGreaterThan(0);

    const changed = await ledger.deliver("s1", [
      { key: "plan", text: "plan: OAuth complete" },
      capsules[1] as { key: string; text: string },
    ]);
    expect(changed.full).toBe(1);
    expect(changed.referenced).toBe(1);
    expect((await ledger.deliver("s2", capsules)).full).toBe(2);
  });

  it("recovers from a corrupt ledger as a fresh session", async () => {
    const repo = await root();
    const directory = join(repo, ".codebuddy", "cache", "session");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.json"), "not json");
    const result = await new SessionCapsuleLedger(repo).deliver("broken", [
      { key: "project", text: "project: demo" },
    ]);
    expect(result.full).toBe(1);
    expect(result.referenced).toBe(0);
  });

  it("serializes concurrent deliveries for the same session", async () => {
    const repo = await root();
    const ledger = new SessionCapsuleLedger(repo);
    const capsule = [{ key: "project", text: "project: demo" }];
    const results = await Promise.all([
      ledger.deliver("shared", capsule),
      ledger.deliver("shared", capsule),
    ]);
    expect(results.reduce((total, result) => total + result.full, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.referenced, 0)).toBe(1);
  });
});
