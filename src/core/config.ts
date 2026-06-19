import { z } from "zod";
import type { CodeBuddyConfig } from "./types.js";

const providerSchema = z.object({
  type: z.literal("huggingface"),
  apiKey: z.string().min(1).optional(),
});

export const codeBuddyConfigSchema = z.object({
  postgresUrl: z.string().min(1, "postgresUrl is required"),
  provider: providerSchema,
  namespace: z
    .string()
    .min(1, "namespace is required")
    .max(128, "namespace must be 128 chars or fewer")
    .regex(/^[a-zA-Z0-9_.:-]+$/, "namespace must match [a-zA-Z0-9_.:-]+"),
  tokenBudget: z.number().int().positive().max(1_000_000).optional(),
  worker: z
    .object({
      pollIntervalMs: z.number().int().min(50).max(60_000).optional(),
      batchSize: z.number().int().min(1).max(64).optional(),
      maxAttempts: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
});

export type ValidatedCodeBuddyConfig = z.infer<typeof codeBuddyConfigSchema>;

export function validateConfig(config: CodeBuddyConfig): ValidatedCodeBuddyConfig {
  return codeBuddyConfigSchema.parse(config);
}
