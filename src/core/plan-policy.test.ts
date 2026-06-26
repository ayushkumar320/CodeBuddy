import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlanPolicy, setPlanPolicy } from "./config-file.js";

const roots: string[] = [];
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.CODEBUDDY_PLAN_POLICY;
  delete process.env.CODEBUDDY_PLAN_POLICY;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.CODEBUDDY_PLAN_POLICY;
  else process.env.CODEBUDDY_PLAN_POLICY = savedEnv;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codebuddy-policy-"));
  roots.push(dir);
  return dir;
}

describe("plan policy", () => {
  it("defaults to suggest when nothing is configured", async () => {
    expect(await loadPlanPolicy(await root())).toBe("suggest");
  });

  it("round-trips a set policy through the config file", async () => {
    const dir = await root();
    await setPlanPolicy("required", dir);
    expect(await loadPlanPolicy(dir)).toBe("required");
    const raw = JSON.parse(await readFile(join(dir, ".codebuddy", "config.json"), "utf8"));
    expect(raw.plan.policy).toBe("required");
  });

  it("preserves other config keys when setting policy", async () => {
    const dir = await root();
    await setPlanPolicy("off", dir);
    const raw = JSON.parse(await readFile(join(dir, ".codebuddy", "config.json"), "utf8"));
    expect(raw.namespace).toBeDefined();
    expect(raw.provider).toBeDefined();
  });

  it("CODEBUDDY_PLAN_POLICY overrides the file", async () => {
    const dir = await root();
    await setPlanPolicy("off", dir);
    process.env.CODEBUDDY_PLAN_POLICY = "required";
    expect(await loadPlanPolicy(dir)).toBe("required");
  });

  it("ignores an invalid env value and falls back to the file", async () => {
    const dir = await root();
    await setPlanPolicy("required", dir);
    process.env.CODEBUDDY_PLAN_POLICY = "bogus";
    expect(await loadPlanPolicy(dir)).toBe("required");
  });
});
