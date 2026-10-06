import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject, PASSWORD } from "../../../../tests/support/cli-build.js";
import { createFakeChroma } from "../../../../tests/support/fake-chroma.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const OPENAPI = `openapi: 3.0.0
info: { title: Demo shop }
paths:
  /orders/{id}/cancel:
    post: { summary: Cancel a paid order within 24 hours }
`;

/** A project with a docs folder; the embedder is fake and local unless `local: false`. */
const setup = async (options: { local?: boolean } = {}) => {
  const embedder = createFakeEmbedder({ local: options.local ?? true });
  const p = await createBuildProject(apiService(), {
    ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }) },
  });
  cleanups.push(p.cleanup);
  const docs = join(p.project, "docs");
  await mkdir(join(docs, "api"), { recursive: true });
  await writeFile(
    join(docs, "orders.md"),
    "# Orders\n## Cancel\nA paid order can be cancelled within 24 hours of payment.\n## Refund\nRefunds reach the card in five working days.\n",
  );
  await writeFile(join(docs, "cart.html"), "<h1>Cart</h1><p>The cart keeps at most twenty items.</p>");
  await writeFile(join(docs, "api", "openapi.yaml"), OPENAPI);
  await writeFile(join(docs, "logo.png"), "png");
  await writeFile(join(docs, ".env"), "TOKEN=abc");
  const knowledge = join(p.home, ".qajitsu", "projects", "demo", "knowledge");
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  const configure = async (line: string) => writeFile(yaml, `${await readFile(yaml, "utf8")}\n${line}\n`);
  return { ...p, docs, embedder, knowledge, configure };
};

describe("qj knowledge (REQ-KNOW-01..05)", () => {
  it("REQ-KNOW-01/AC1 + REQ-KNOW-02/AC1+AC3+AC4 + REQ-KNOW-05/AC1+AC3: empty until add; add records sources and only processes changes", async () => {
    const p = await setup();
    expect((await p.run(["knowledge", "list"])).out).toContain("Knowledge base of demo: empty");
    expect((await p.run(["status"])).out).toContain("Knowledge base: empty");
    const added = await p.run(["knowledge", "add", "docs"]);
    expect(added.exitCode).toBe(0);
    expect(added.out).toContain(
      "Knowledge base of demo: 3 added, 0 updated, 0 unchanged, 2 skipped, 0 removed",
    );
    expect(added.out).toContain("mode full");
    expect(added.out).toContain("skipped docs/.env: never indexed");
    expect(added.out).toContain("skipped docs/logo.png: unsupported format .png");
    const sources = await readFile(join(p.knowledge, "sources.yaml"), "utf8");
    expect(sources).toContain(`path: ${p.docs}`);
    expect(sources).toContain("name: docs");
    expect((await p.run(["knowledge", "add", "docs"])).out).toContain("0 added, 0 updated, 3 unchanged");
    await writeFile(join(p.docs, "cart.html"), "<h1>Cart</h1><p>The cart keeps at most thirty items.</p>");
    expect((await p.run(["knowledge", "add", "docs"])).out).toContain("0 added, 1 updated, 2 unchanged");
    const list = await p.run(["knowledge", "list"]);
    expect(list.out).toMatch(
      /1 source\(s\), 3 file\(s\), \d+ chunk\(s\) · mode full · embedding none \(full mode\) · store lancedb · [\d.]+ MB on disk/,
    );
    expect(list.out).toMatch(
      / {2}docs {2}.*docs {2}3 file\(s\) {2}\d+ chunk\(s\) {2}tags - {2}last sync 20\d\d-/,
    );
    expect((await p.run(["status"])).out).toMatch(/Knowledge base: 1 source\(s\), mode full, last sync 20/);
    // Full mode never computes embeddings (REQ-KNOW-07/AC1).
    expect(p.embedder.calls).toEqual([]);
  }, 120_000);

  it("REQ-KNOW-01/AC2 + REQ-KNOW-02/AC1+AC2 + REQ-KNOW-05/AC2: filters, tags, the .qa/knowledge source, and search with sources", async () => {
    const p = await setup();
    await mkdir(join(p.project, ".qa", "knowledge"));
    await writeFile(
      join(p.project, ".qa", "knowledge", "glossary.md"),
      "# Glossary\nA paid order is an order with a captured payment.\n",
    );
    const added = await p.run([
      "knowledge",
      "add",
      "docs",
      "--include",
      "**/*.md",
      "--include",
      "*.yaml",
      "--exclude",
      "cart.*",
      "--tag",
      "api",
    ]);
    expect(added.out).toContain("2 added");
    expect((await p.run(["knowledge", "add", "--qa-knowledge"])).out).toContain("1 added");
    const found = await p.run(["knowledge", "search", "cancel paid order"]);
    expect(found.out).toMatch(
      /^\d\. docs\/orders\.md › Orders > Cancel \(20\d\d-\d\d-\d\d\) \[[0-9a-f]{16}-0\]\n {3}A paid order can be cancelled within 24 hours/m,
    );
    expect(found.out).toContain("docs/api/openapi.yaml › POST /orders/{id}/cancel");
    expect(found.out).toContain("qa-knowledge/glossary.md › Glossary");
    const tagged = await p.run(["knowledge", "search", "paid order", "--tag", "api", "--limit", "10"]);
    expect(tagged.out).not.toContain("qa-knowledge/");
    expect((await p.run(["knowledge", "search", "zebra"])).out).toBe(
      "Project: demo (active project)\nNo matching documentation.\n",
    );
    expect((await p.run(["knowledge", "search", "x", "--limit", "0"])).err).toContain(
      "[KNOWLEDGE_LIMIT_INVALID]",
    );
  }, 120_000);

  it("REQ-KNOW-04/AC1+AC2 + REQ-KNOW-03/AC1: sync picks up changed, new and deleted files; --dry-run changes nothing", async () => {
    const p = await setup();
    await p.run(["knowledge", "add", "docs"]);
    await writeFile(
      join(p.docs, "orders.md"),
      "# Orders\n## Cancel\nA paid order can be cancelled within 48 hours.\n",
    );
    await writeFile(join(p.docs, "login.md"), "# Login\nThree failed logins lock the account.\n");
    await rm(join(p.docs, "cart.html"));
    const dry = await p.run(["knowledge", "sync", "--dry-run"]);
    expect(dry.out).toContain(
      "would be 1 added, would be 1 updated, 1 unchanged, 2 skipped, would be 1 removed",
    );
    expect(dry.out).toContain("would index docs/login.md");
    expect(dry.out).toContain("would remove docs/cart.html");
    expect((await p.run(["knowledge", "search", "cart items"])).out).toContain("docs/cart.html");
    const sync = await p.run(["knowledge", "sync"]);
    expect(sync.out).toContain("1 added, 1 updated, 1 unchanged, 2 skipped, 1 removed");
    expect((await p.run(["knowledge", "search", "cart items twenty"])).out).not.toContain("docs/cart.html");
    expect((await p.run(["knowledge", "search", "cancelled hours"])).out).toContain("within 48 hours");
  }, 120_000);

  it("REQ-KNOW-03/AC1+AC2: remove a file or a source; reset needs confirmation and can keep sources", async () => {
    const p = await setup();
    await p.run(["knowledge", "add", "docs"]);
    const removed = await p.run(["knowledge", "remove", "docs/orders.md"]);
    expect(removed.out).toMatch(
      /Removed docs\/orders\.md \(\d chunk\(s\)\); it is excluded from source docs\./,
    );
    expect((await p.run(["knowledge", "search", "paid order cancelled"])).out).not.toContain(
      "docs/orders.md",
    );
    expect((await p.run(["knowledge", "sync"])).out).toContain("0 added");
    expect((await p.run(["knowledge", "remove", "nothing"])).err).toContain("[KNOWLEDGE_NOT_FOUND]");
    expect((await p.run(["knowledge", "reset"])).err).toContain("pass --yes");
    expect((await p.run(["knowledge", "reset"], undefined, { ask: ["n"] })).exitCode).toBe(3);
    const reset = await p.run(["knowledge", "reset", "--keep-sources"], undefined, { ask: ["y"] });
    expect(reset.out).toMatch(/emptied \(\d+ chunk\(s\) deleted\); 1 source\(s\) kept/);
    expect((await p.run(["knowledge", "search", "cart"])).out).toContain("No matching documentation");
    expect((await p.run(["knowledge", "sync"])).out).toContain("2 added");
    expect((await p.run(["knowledge", "remove", "docs"])).out).toMatch(
      /Removed source docs \(\d+ chunk\(s\)\)/,
    );
    expect((await p.run(["knowledge", "list"])).out).toContain("empty");
    await p.run(["knowledge", "add", "docs"]);
    expect((await p.run(["knowledge", "reset", "--yes"])).out).toContain("emptied");
    expect((await p.run(["knowledge", "list"])).out).toContain("empty");
  }, 120_000);
});

describe("retrieval mode and embeddings (REQ-KNOW-07, REQ-KNOW-08)", () => {
  it("REQ-KNOW-07/AC2+AC3 + REQ-KNOW-08/AC2: above the budget retrieval is hybrid; a different model needs reindex", async () => {
    const p = await setup();
    await p.configure("knowledge: { full_context_tokens: 10 }");
    expect((await p.run(["knowledge", "add", "docs"])).out).toContain("mode hybrid");
    expect(p.embedder.calls.length).toBeGreaterThan(0);
    const list = await p.run(["knowledge", "list"]);
    expect(list.out).toContain("mode hybrid · embedding ollama/nomic-embed-text");
    expect((await p.run(["knowledge", "search", "when does a refund reach the card"])).out).toMatch(
      /^1\. docs\/orders\.md › Orders > Refund/m,
    );
    const index = JSON.parse(await readFile(join(p.knowledge, "index.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(index).toMatchObject({
      mode: "hybrid",
      embedding: "ollama/nomic-embed-text",
      dimensions: 64,
      store: "lancedb",
    });
    await p.configure("# switched model");
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "knowledge: { full_context_tokens: 10 }",
        "knowledge: { full_context_tokens: 10, embedding: local/other-embed }",
      ),
    );
    await writeFile(join(p.docs, "login.md"), "# Login\nThree failed logins lock the account.\n");
    expect((await p.run(["knowledge", "sync"])).err).toContain("[KNOWLEDGE_EMBEDDING_CHANGED]");
    expect((await p.run(["knowledge", "search", "refund"])).err).toContain("[KNOWLEDGE_EMBEDDING_CHANGED]");
    const re = await p.run(["knowledge", "reindex"]);
    expect(re.out).toContain("(rebuilt)");
    expect(JSON.parse(await readFile(join(p.knowledge, "index.json"), "utf8"))).toMatchObject({
      mode: "hybrid",
      embedding: "local/other-embed",
    });
    expect((await p.run(["knowledge", "sync"])).exitCode).toBe(0);
  }, 120_000);

  it("REQ-KNOW-07/AC1: when documentation shrinks below the budget it is stored again without embeddings", async () => {
    const p = await setup();
    await p.configure("knowledge: { full_context_tokens: 60 }");
    expect((await p.run(["knowledge", "add", "docs"])).out).toContain("mode hybrid");
    await rm(join(p.docs, "api"), { recursive: true });
    await rm(join(p.docs, "orders.md"));
    const sync = await p.run(["knowledge", "sync"]);
    expect(sync.out).toContain("mode full (rebuilt)");
    expect((await p.run(["knowledge", "search", "cart"])).out).toContain("docs/cart.html");
  }, 120_000);
});

describe("knowledge security (REQ-KNOW-09)", () => {
  it("REQ-KNOW-09/AC1: secret values and credential-shaped strings are masked before indexing", async () => {
    const p = await setup();
    await writeFile(
      join(p.docs, "accounts.md"),
      `# Accounts\nLog in as standard with ${PASSWORD}.\nCI token ghp_abcdefghijklmnopqrstuvwxyz0123456789 is used by the pipeline.\n`,
    );
    await p.run(["knowledge", "add", "docs"]);
    const out = (await p.run(["knowledge", "search", "log in standard pipeline token"])).out;
    expect(out).toContain("docs/accounts.md");
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain("ghp_abc");
  }, 120_000);

  it("REQ-KNOW-09/AC2: a cloud embedding model needs confirmation once per project", async () => {
    const p = await setup({ local: false });
    await p.configure("knowledge: { full_context_tokens: 10 }");
    const refused = await p.run(["knowledge", "add", "docs"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("will be sent to ollama/nomic-embed-text, a cloud embedding model");
    expect(refused.err).toContain("[KNOWLEDGE_CLOUD_CONSENT]");
    expect(p.embedder.calls).toEqual([]);
    expect((await p.run(["knowledge", "add", "docs"], undefined, { ask: ["no"] })).exitCode).toBe(3);
    expect((await p.run(["knowledge", "add", "docs", "--yes"])).exitCode).toBe(0);
    await writeFile(join(p.docs, "login.md"), "# Login\nThree failed logins lock the account.\n");
    const again = await p.run(["knowledge", "sync"]);
    expect(again.exitCode).toBe(0);
    expect(again.err).not.toContain("cloud embedding model");
  }, 120_000);

  it("REQ-KNOW-09/AC3: another project never sees this project's knowledge base", async () => {
    const p = await setup();
    await p.run(["knowledge", "add", "docs"]);
    expect(
      (await p.run(["init", "other", "--qa-dir", join(p.project, ".qa"), "--yes", "--no-use"])).exitCode,
    ).toBeLessThan(3);
    const other = await p.run(["--project", "other", "knowledge", "search", "paid order cancelled"]);
    expect(other.out).toContain("Project: other (flag)");
    expect(other.out).toContain("No matching documentation");
    expect((await p.run(["--project", "other", "knowledge", "list"])).out).toContain(
      "Knowledge base of other: empty",
    );
  }, 120_000);
});

describe("chroma store (REQ-KNOW-08/AC3)", () => {
  it("REQ-KNOW-08/AC3: knowledge.store chroma keeps the project's chunks in its own collection on the shared server", async () => {
    const server = createFakeChroma();
    const embedder = createFakeEmbedder();
    const p = await createBuildProject(apiService(), {
      ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }), fetch: server.fetch },
    });
    cleanups.push(p.cleanup);
    await mkdir(join(p.project, "docs"));
    await writeFile(
      join(p.project, "docs", "orders.md"),
      "# Orders\nA paid order can be cancelled within 24 hours.\n",
    );
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(yaml, `${await readFile(yaml, "utf8")}\nknowledge: { store: chroma }\n`);
    expect((await p.run(["knowledge", "list"])).err).toContain("[KNOWLEDGE_CHROMA_NOT_CONFIGURED]");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "knowledge: { store: chroma }",
        "knowledge: { store: chroma, chroma: { url: secret://env/CHROMA_URL, token: secret://env/CHROMA_TOKEN } }",
      ),
    );
    const env = { CHROMA_URL: "https://chroma.example.com", CHROMA_TOKEN: "chroma-team-token" };
    const added = await p.run(["knowledge", "add", "docs"], undefined, { env });
    expect(added.exitCode).toBe(0);
    expect(added.out).toContain("1 added");
    expect([...server.collections.keys()]).toEqual(["qajitsu-demo"]);
    expect(server.requests.every((r) => r.token === "chroma-team-token")).toBe(true);
    const found = await p.run(["knowledge", "search", "cancel paid order"], undefined, { env });
    expect(found.out).toContain("docs/orders.md › Orders");
    const list = await p.run(["knowledge", "list"], undefined, { env });
    expect(list.out).toContain("store chroma");
    expect(list.out + list.err + added.out + found.out).not.toContain("chroma-team-token");
  }, 120_000);
});
