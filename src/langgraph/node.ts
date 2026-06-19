import type { CodeBuddy } from "../core/codebuddy.js";
import type { CodeBuddyState } from "./types.js";

export type CodeBuddyNodeOptions = {
  memory: CodeBuddy;
  mode: "recall" | "remember";
  cacheTtlSeconds?: number;
};

export class CodeBuddyNode {
  readonly options: CodeBuddyNodeOptions;
  private readonly cache = new Map<
    string,
    { expiresAt: number; memory: CodeBuddyState["memory"] }
  >();

  constructor(options: CodeBuddyNodeOptions) {
    this.options = options;
  }

  async invoke(_state: CodeBuddyState): Promise<Partial<CodeBuddyState>> {
    if (this.options.mode === "recall") {
      const query = lastMessageText(_state.messages);
      const namespace = this.options.memory.config.namespace;
      const key = `${namespace}\x1f${_state.sessionId}\x1f${query}`;
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.memory ? { memory: cached.memory } : {};
      }
      const memory = await this.options.memory.recall({
        sessionId: _state.sessionId,
        query,
      });
      const ttl = Math.max(0, this.options.cacheTtlSeconds ?? 30);
      if (ttl > 0) {
        this.cache.set(key, { expiresAt: Date.now() + ttl * 1000, memory });
      }
      return { memory };
    }

    const content = lastMessageText(_state.messages);
    if (!content) return {};
    await this.options.memory.remember({
      sessionId: _state.sessionId,
      content,
      ...(typeof _state.agentId === "string" ? { agentId: _state.agentId } : {}),
    });
    return {};
  }

  async call(state: CodeBuddyState): Promise<Partial<CodeBuddyState>> {
    return this.invoke(state);
  }
}

function lastMessageText(messages: unknown[]): string {
  const message = messages.at(-1);
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message !== "object") return String(message);
  const maybe = message as { content?: unknown; text?: unknown };
  const content = maybe.content ?? maybe.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}
