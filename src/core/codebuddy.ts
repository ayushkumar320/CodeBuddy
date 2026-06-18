import type {
  CodeBuddyConfig,
  CodeBuddyStatus,
  RecallInput,
  RecallResult,
  RememberBatchItem,
  RememberInput,
  RememberResult,
  ShareInput,
} from "./types.js";

export class CodeBuddy {
  readonly config: CodeBuddyConfig;

  constructor(config: CodeBuddyConfig) {
    this.config = config;
  }

  async init(): Promise<CodeBuddyStatus> {
    return {
      ready: false,
      phase: "foundation",
      message: "CodeBuddy foundation is scaffolded. Storage is implemented in Phase 2.",
    };
  }

  async remember(_input: RememberInput): Promise<RememberResult> {
    throw new Error("CodeBuddy.remember is implemented in Phase 4.");
  }

  async rememberBatch(_items: RememberBatchItem[]): Promise<RememberResult[]> {
    throw new Error("CodeBuddy.rememberBatch is implemented in Phase 4.");
  }

  async recall(_input: RecallInput): Promise<RecallResult> {
    throw new Error("CodeBuddy.recall is implemented in Phase 5.");
  }

  async share(_input: ShareInput): Promise<{ shared: number }> {
    throw new Error("CodeBuddy.share is implemented in Phase 4.");
  }

  async forget(_id: string): Promise<{ ok: boolean }> {
    throw new Error("CodeBuddy.forget is implemented in Phase 4.");
  }
}
