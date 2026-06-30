import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RiskAssessor } from "../assessor.js";
import { createPolicySignal, readPolicyFile } from "./policy.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-policy-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createPolicySignal", () => {
  it("matches policy rules against paths", async () => {
    const root = await temporaryRoot();
    const policyPath = join(root, "policies.yaml");
    await writeFile(
      policyPath,
      [
        "rules:",
        "  - id: auth-sensitive",
        "    pattern: src/auth/**",
        "    message: Auth code needs review.",
        "    weight: 70",
      ].join("\n"),
    );

    const assessment = await new RiskAssessor([
      createPolicySignal({ repositoryRoot: root, policyPath }),
    ]).assess({
      repositoryRoot: root,
      namespace: "demo",
      paths: ["src/auth/oauth.ts", "src/ui/button.ts"],
    });

    expect(assessment.items).toHaveLength(1);
    expect(assessment.items[0]).toMatchObject({
      path: "src/auth/oauth.ts",
      score: 70,
      category: "policy",
      reason: "Auth code needs review.",
    });
    expect(assessment.items[0]?.evidence[0]).toMatchObject({
      kind: "policy_rule",
      ruleId: "auth-sensitive",
    });
  });

  it("returns an empty policy when no file exists", async () => {
    await expect(readPolicyFile(join(await temporaryRoot(), "missing.yaml"))).resolves.toEqual({
      rules: [],
    });
  });
});
