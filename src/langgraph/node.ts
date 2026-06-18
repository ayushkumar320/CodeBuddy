import type { CodeBuddyState } from "./types.js";

export type CodeBuddyNodeOptions = {
  mode: "recall" | "remember";
  cacheTtlSeconds?: number;
};

export class CodeBuddyNode {
  readonly options: CodeBuddyNodeOptions;

  constructor(options: CodeBuddyNodeOptions) {
    this.options = options;
  }

  async invoke(_state: CodeBuddyState): Promise<Partial<CodeBuddyState>> {
    throw new Error("CodeBuddyNode is implemented in Phase 6.");
  }
}
