import { describe, expect, it } from "vitest";
import { type HookSettings, hooksInstalled, removeHooks, upsertHooks } from "./settings.js";

describe("upsertHooks", () => {
  it("adds the three CodeBuddy hooks to an empty settings object", () => {
    const { settings, changed } = upsertHooks({});
    expect(changed).toBe(true);
    const hooks = settings.hooks ?? {};
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "Stop", "UserPromptSubmit"]);
    expect(hooks.PostToolUse?.[0]?.matcher).toBe("Edit|Write|MultiEdit");
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe("codebuddy hooks capture");
  });

  it("is idempotent — a second install changes nothing", () => {
    const first = upsertHooks({});
    const second = upsertHooks(first.settings);
    expect(second.changed).toBe(false);
    expect(second.settings.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves the user's own hooks", () => {
    const existing: HookSettings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-own-thing" }] }],
      },
    };
    const { settings } = upsertHooks(existing);
    const groups = settings.hooks?.UserPromptSubmit ?? [];
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.hooks[0]?.command === "my-own-thing")).toBe(true);
    expect(groups.some((g) => g.hooks[0]?.command === "codebuddy hooks context")).toBe(true);
  });
});

describe("removeHooks", () => {
  it("removes only CodeBuddy hooks and drops emptied events", () => {
    const installed = upsertHooks({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "keep-me" }] }] },
    }).settings;

    const { settings, changed } = removeHooks(installed);
    expect(changed).toBe(true);
    expect(hooksInstalled(settings)).toBe(false);
    // The user's hook survives; the CodeBuddy-only events are gone.
    expect(settings.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe("keep-me");
    expect(settings.hooks?.Stop).toBeUndefined();
  });

  it("is a no-op when nothing is installed", () => {
    expect(removeHooks({}).changed).toBe(false);
  });
});

describe("hooksInstalled", () => {
  it("detects presence and absence", () => {
    expect(hooksInstalled({})).toBe(false);
    expect(hooksInstalled(upsertHooks({}).settings)).toBe(true);
  });
});
