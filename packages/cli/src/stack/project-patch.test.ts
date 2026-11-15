import { parseProjectConfig } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { patchProjectForStack, stackModels } from "./project-patch.js";

const SOURCE = `# The shop's QA settings
project: shop
jira: { type: file, tickets_dir: ../tickets, project_key: SHOP }
code_hosts: { local: { type: local, root: ~/git } }
repos: { shop: { host: local, path: shop-org/shop } }
models:
  providers:
    claude: { type: anthropic, api_key: "secret://env/ANTHROPIC_API_KEY" }
  roles:
    planner: claude/claude-sonnet-5 # the strong one
    author: claude/claude-sonnet-5
environments: { allowlist: ["http://localhost:3000"] }
`;
const doc = (text: string) => parse(text) as Record<string, Record<string, unknown>>;

describe("the project's models follow the stack (REQ-GEN-10/AC3)", () => {
  it("REQ-GEN-10/AC3: models.roles names exactly the models the stack pulls, through a stack provider", () => {
    const roles = { default: "qwen3:4b", auditor: "gemma3:4b" };
    const out = patchProjectForStack(SOURCE, { roles, chroma: false });
    const models = doc(out)["models"] as {
      providers: Record<string, unknown>;
      roles: Record<string, string>;
    };
    expect(models.providers["stack"]).toEqual({ type: "ollama", base_url: "http://ollama:11434" });
    expect(models.roles).toEqual({
      planner: "claude/claude-sonnet-5",
      author: "claude/claude-sonnet-5",
      default: "stack/qwen3:4b",
      auditor: "stack/gemma3:4b",
    });
    // What is pulled is what is named: every stack/ role model, plus the embedding model the knowledge base uses.
    expect(stackModels(out)).toEqual(["gemma3:4b", "nomic-embed-text:latest", "qwen3:4b"]);
    // The result is a valid project configuration.
    expect(() => parseProjectConfig(parse(out) as unknown)).not.toThrow();
  });

  it("REQ-GEN-10/AC3: comments, order and unrelated keys of qa.project.yaml stay as they were", () => {
    const out = patchProjectForStack(SOURCE, { roles: { auditor: "gemma3:12b" }, chroma: false });
    // The yaml library may pad inline lists ([ a ]); the values and every comment stay.
    expect(out.startsWith("# The shop's QA settings\nproject: shop\n")).toBe(true);
    expect(out).toContain("planner: claude/claude-sonnet-5 # the strong one");
    expect(Object.keys(doc(out))).toEqual([...Object.keys(doc(SOURCE)), "knowledge"]);
    const before = doc(SOURCE);
    const after = doc(out);
    for (const key of ["project", "jira", "code_hosts", "repos", "test_types", "environments"])
      expect(after[key], key).toEqual(before[key]);
  });

  it("REQ-GEN-10/AC3: a hybrid preset keeps the cloud models of the roles it does not set", () => {
    const out = patchProjectForStack(SOURCE, {
      roles: { analyst: "qwen3:8b", summary: "qwen3:8b", triage: "qwen3:8b", auditor: "gemma3:12b" },
      chroma: false,
    });
    const roles = (doc(out)["models"] as { roles: Record<string, string> }).roles;
    expect(roles["planner"]).toBe("claude/claude-sonnet-5");
    expect(roles["author"]).toBe("claude/claude-sonnet-5");
    expect(roles["analyst"]).toBe("stack/qwen3:8b");
    expect(stackModels(out)).toEqual(["gemma3:12b", "nomic-embed-text:latest", "qwen3:8b"]);
  });

  it("REQ-GEN-10/AC3: the knowledge base's Ollama embedding model is served by the stack; another provider's stays", () => {
    const local = patchProjectForStack(SOURCE, { roles: {}, chroma: false });
    expect(doc(local)["knowledge"]).toEqual({ embedding: "stack/nomic-embed-text:latest" });
    const openai = SOURCE.replace(
      "  roles:",
      '    oa: { type: openai, api_key: "secret://env/OPENAI_API_KEY" }\n  roles:',
    ).concat("knowledge: { embedding: oa/text-embedding-3-small }\n");
    const kept = patchProjectForStack(openai, { roles: {}, chroma: false });
    expect(doc(kept)["knowledge"]).toEqual({ embedding: "oa/text-embedding-3-small" });
    expect(stackModels(kept)).toEqual([]);
  });

  it("REQ-GEN-10/AC2+AC5: the stack's Chroma is reached through a secret:// reference the stack sets, not a written URL", () => {
    const out = patchProjectForStack(SOURCE.concat("knowledge: { store: chroma }\n"), {
      roles: {},
      chroma: true,
    });
    expect(doc(out)["knowledge"]).toMatchObject({
      store: "chroma",
      chroma: { url: "secret://env/QAJITSU_CHROMA_URL" },
    });
    expect(() => parseProjectConfig(parse(out) as unknown)).not.toThrow();
  });

  it("REQ-GEN-10/AC3: a stack provider the project defines differently is not overwritten silently", () => {
    const taken = SOURCE.replace(
      "  roles:",
      '    stack: { type: openai, api_key: "secret://env/X" }\n  roles:',
    );
    expect(() => patchProjectForStack(taken, { roles: {}, chroma: false })).toThrow(
      /models\.providers\.stack/,
    );
  });
});
