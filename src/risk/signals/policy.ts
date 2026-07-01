import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Signal, SignalContribution } from "../types.js";

const policyRuleSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  message: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  weight: z.number().min(0).max(100).default(50),
});

const policyFileSchema = z.object({
  rules: z.array(policyRuleSchema).default([]),
});

export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyFile = z.infer<typeof policyFileSchema>;

export type PolicySignalOptions = {
  repositoryRoot: string;
  enabled?: boolean;
  coefficient?: number;
  policyPath?: string;
};

export function createPolicySignal(options: PolicySignalOptions): Signal {
  return {
    id: "policy",
    category: "policy",
    enabled: options.enabled ?? true,
    coefficient: options.coefficient ?? 1,
    async assess(input) {
      const policy = await readPolicyFile(
        options.policyPath ?? join(options.repositoryRoot, ".codebuddy", "policies.yaml"),
      );
      if (policy.rules.length === 0) return [];

      const byPath = new Map<string, SignalContribution>();
      for (const path of input.paths) {
        for (const rule of policy.rules) {
          if (!matchesPolicyGlob(path, rule.pattern)) continue;
          const existing = byPath.get(path);
          const evidence = { kind: "policy_rule" as const, ruleId: rule.id, pattern: rule.pattern };
          const reason = rule.message ?? rule.reason ?? `Policy rule ${rule.id} matched ${path}.`;
          if (!existing) {
            byPath.set(path, {
              path,
              weight: rule.weight,
              reason,
              evidence: [evidence],
            });
            continue;
          }
          existing.weight = Math.max(existing.weight, rule.weight);
          existing.evidence.push(evidence);
          if (rule.weight >= existing.weight) existing.reason = reason;
        }
      }
      return [...byPath.values()];
    },
  };
}

export async function readPolicyFile(path: string): Promise<PolicyFile> {
  try {
    const raw = await readFile(path, "utf8");
    return policyFileSchema.parse(parseYaml(raw) ?? {});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [] };
    throw error;
  }
}

/** Match a repo-relative path against a simple `*` / `**` glob pattern. */
export function matchesPolicyGlob(path: string, glob: string): boolean {
  const normalizedPath = normalize(path);
  const normalizedGlob = normalize(glob);
  const pattern = normalizedGlob
    .split("**")
    .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(normalizedPath);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
