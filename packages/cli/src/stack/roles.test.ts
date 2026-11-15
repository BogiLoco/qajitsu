import { describe, expect, it } from "vitest";
import type { ModelFacts } from "./inspect.js";
import { effectiveRoles, stackContextLength, stackRoleProblems } from "./roles.js";

const D = `sha256:${"a".repeat(64)}`;
const facts = (list: Omit<ModelFacts, "digest" | "size" | "kvBytesPerToken">[]) =>
  new Map(list.map((f) => [f.name, { ...f, digest: D, size: 0, kvBytesPerToken: undefined }]));
const QWEN = { name: "qwen3:4b", tools: true, vision: false, contextWindow: 262_144 };
const GPT = { name: "gpt-oss:20b", tools: true, vision: false, contextWindow: 131_072 };
const MISTRAL = { name: "mistral-small3.2:24b", tools: true, vision: true, contextWindow: 131_072 };
const GEMMA = { name: "gemma3:4b", tools: false, vision: true, contextWindow: 131_072 };
const QWEN8 = { name: "qwen3:8b", tools: true, vision: false, contextWindow: 40_960 };

describe("the stack's models can serve their roles (REQ-GEN-10/AC3, REQ-LLM-03)", () => {
  it("REQ-GEN-10/AC3: the stack's roles win over the project's, its default only fills roles the project leaves open", () => {
    expect(
      effectiveRoles(
        { planner: "claude/sonnet", default: "claude/haiku" },
        { default: "qwen3:4b", auditor: "mistral-small3.2:24b" },
      ),
    ).toEqual({
      analyst: "stack/qwen3:4b",
      planner: "claude/sonnet",
      author: "stack/qwen3:4b",
      healer: "stack/qwen3:4b",
      auditor: "stack/mistral-small3.2:24b",
      explorer: "stack/qwen3:4b",
      summary: "stack/qwen3:4b",
      triage: "stack/qwen3:4b",
    });
    // Only some roles local (hybrid): the rest keeps the project's models, its default included.
    expect(effectiveRoles({ default: "claude/sonnet" }, { summary: "qwen3:4b" })).toMatchObject({
      summary: "stack/qwen3:4b",
      author: "claude/sonnet",
    });
  });

  it("REQ-GEN-10/AC3: Ollama gets the largest context a role it serves needs", () => {
    expect(stackContextLength({ summary: "stack/qwen3:4b", triage: "stack/qwen3:4b" })).toBe(32_768);
    expect(stackContextLength({ analyst: "stack/qwen3:4b", author: "claude/x" })).toBe(65_536);
    expect(stackContextLength({ author: "stack/qwen3:4b" })).toBe(131_072);
    expect(stackContextLength({})).toBe(32_768);
  });

  it("REQ-GEN-10/AC3: the local preset serves every role; a model without tools, vision or context is refused", () => {
    const local = effectiveRoles(
      {},
      { default: "gpt-oss:20b", summary: "qwen3:4b", triage: "qwen3:4b", auditor: "mistral-small3.2:24b" },
    );
    const all = facts([QWEN, GPT, MISTRAL, GEMMA, QWEN8]);
    expect(stackRoleProblems({ roles: local, facts: all, contextLength: 131_072, off: new Set() })).toEqual(
      [],
    );
    // gemma3 has vision but no tools: it cannot be the auditor.
    const gemma = { ...local, auditor: "stack/gemma3:4b" };
    expect(stackRoleProblems({ roles: gemma, facts: all, contextLength: 131_072, off: new Set() })).toEqual([
      "auditor: gemma3:4b lacks tools",
    ]);
    // qwen3:8b knows 40k tokens: enough for summary, not for the author.
    const short = { ...local, author: "stack/qwen3:8b", summary: "stack/qwen3:8b" };
    expect(stackRoleProblems({ roles: short, facts: all, contextLength: 131_072, off: new Set() })).toEqual([
      "author: qwen3:8b lacks contextWindow>=128000",
    ]);
    // A model is only as long as the stack lets it be.
    expect(stackRoleProblems({ roles: local, facts: all, contextLength: 65_536, off: new Set() })).toContain(
      "author: gpt-oss:20b lacks contextWindow>=128000",
    );
  });

  it("REQ-GEN-10/AC3: the small preset's model has no vision: the auditor needs another model, unless it is off", () => {
    const small = effectiveRoles({}, { default: "qwen3:4b" });
    const all = facts([QWEN]);
    expect(stackRoleProblems({ roles: small, facts: all, contextLength: 131_072, off: new Set() })).toEqual([
      "auditor: qwen3:4b lacks vision",
      "auditor: stack/qwen3:4b is the author's model; the auditor reviews with another one (REQ-VER-06)",
    ]);
    expect(
      stackRoleProblems({ roles: small, facts: all, contextLength: 131_072, off: new Set(["auditor"]) }),
    ).toEqual([]);
    // A cloud auditor the project has configured is kept, and not checked here.
    const withCloud = effectiveRoles({ auditor: "claude/sonnet" }, { default: "qwen3:4b" });
    expect(
      stackRoleProblems({ roles: withCloud, facts: all, contextLength: 131_072, off: new Set() }),
    ).toEqual([]);
  });
});
