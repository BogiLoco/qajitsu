// REQ-GEN-10/AC5 + invariant 8: `qajitsu stack init` never writes a secret into compose.yaml or qa.project.yaml, never
// prints one and never sends one to a registry, even when a renderer or an option tries to.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStackInit } from "../../packages/cli/src/commands/stack.js";
import { renderStackCompose } from "../../packages/cli/src/stack/compose.js";
import { createFakeFetch } from "../support/fake-fetch.js";
import { ollamaRegistryRoutes } from "../support/ollama-registry.js";

// Built at runtime: fictional values that look like the real thing.
const JIRA = ["jira", "tok", "en", "-", "f1ct10nal", "-", "9z8y7x"].join("");
const CHROMA = ["chroma", "-", "s3cr3t", "-", "vault"].join("");
const KEY = ["sk", "-ant-", "fictional", "Key", "0123456789"].join("");
const IMAGE = `ghcr.io/bogiloco/qajitsu:0.1.0@sha256:${"1".repeat(64)}`;
const CONFIG = [
  "project: shop",
  "jira: { type: cloud, base_url: 'https://shop.atlassian.net', email: 'secret://env/JIRA_EMAIL', token: 'secret://env/JIRA_TOKEN', project_key: SHOP }",
  "code_hosts: { local: { type: local, root: ~/git } }",
  "repos: { shop: { host: local, path: shop-org/shop } }",
  "models: { providers: { claude: { type: anthropic, api_key: 'secret://env/ANTHROPIC_API_KEY' } }, roles: { planner: claude/claude-sonnet-5, author: claude/claude-sonnet-5, healer: claude/claude-sonnet-5 } }",
  "knowledge: { store: chroma }",
  "environments: { allowlist: ['http://localhost:3000'] }",
  "",
].join("\n");
const ENV = `JIRA_EMAIL=qa@example.test\nJIRA_TOKEN=${JIRA}\nCHROMA_TOKEN="${CHROMA}"\nexport ANTHROPIC_API_KEY=${KEY}\n`;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), "qj-stack-secrets-"));
  dirs.push(dir);
  await mkdir(join(dir, ".qa"));
  await writeFile(join(dir, ".qa", "qa.project.yaml"), CONFIG);
  await writeFile(join(dir, ".env.local"), ENV);
  const out: string[] = [];
  const fake = createFakeFetch(ollamaRegistryRoutes());
  return {
    dir,
    out,
    fake,
    io: { cwd: dir, write: (t: string) => out.push(t), writeError: (t: string) => out.push(t) },
  };
};
const secrets = [JIRA, CHROMA, KEY];
const holds = (text: string) => secrets.filter((s) => text.includes(s));

describe("the stack never carries a secret (REQ-GEN-10/AC5, invariant 8)", () => {
  it("REQ-GEN-10/AC5: no value of .env.local reaches compose.yaml, qa.project.yaml, the output or a request", async () => {
    const t = await setup();
    expect(
      await runStackInit({ yes: true, preset: "hybrid", image: IMAGE }, t.io, { fetch: t.fake.fetch }),
    ).toBe(0);
    const compose = await readFile(join(t.dir, "compose.yaml"), "utf8");
    const config = await readFile(join(t.dir, ".qa", "qa.project.yaml"), "utf8");
    expect(holds(compose)).toEqual([]);
    expect(holds(config)).toEqual([]);
    expect(holds(t.out.join(""))).toEqual([]);
    expect(holds(JSON.stringify(t.fake.requests))).toEqual([]);
    // The secrets stay where they were: references in the config, values in .env.local only.
    expect(config).toContain("secret://env/JIRA_TOKEN");
    expect(compose).toContain(".env.local");
    // The secrets file is read, never rewritten.
    expect(await readFile(join(t.dir, ".env.local"), "utf8")).toBe(ENV);
  });

  it("REQ-GEN-10/AC5: a renderer that leaks a secret is refused and nothing is written", async () => {
    const t = await setup();
    const leaking = (plan: Parameters<typeof renderStackCompose>[0]) =>
      `${renderStackCompose(plan)}\n# debug: JIRA_TOKEN=${JIRA}\n`;
    expect(
      await runStackInit({ yes: true, preset: "hybrid", image: IMAGE }, t.io, {
        fetch: t.fake.fetch,
        render: leaking,
      }),
    ).toBe(3);
    expect(t.out.join("")).toContain("would hold a value of .env.local; nothing was written");
    await expect(readFile(join(t.dir, "compose.yaml"), "utf8")).rejects.toThrow();
    expect(await readFile(join(t.dir, ".qa", "qa.project.yaml"), "utf8")).toBe(CONFIG);
    expect(holds(t.out.join(""))).toEqual([]);
  });

  it("REQ-GEN-10/AC5: an option carrying a secret is refused before any request is made", async () => {
    for (const options of [
      { volume: [`home=/tmp/${KEY}`] },
      { model: [`default=${CHROMA}:latest`] },
      { image: `ghcr.io/bogiloco/${JIRA}@sha256:${"1".repeat(64)}` },
    ]) {
      const t = await setup();
      const code = await runStackInit({ yes: true, preset: "hybrid", image: IMAGE, ...options }, t.io, {
        fetch: t.fake.fetch,
      });
      expect(code, JSON.stringify(options)).toBe(3);
      expect(t.fake.requests, JSON.stringify(options)).toEqual([]);
      expect(holds(t.out.join("")), JSON.stringify(options)).toEqual([]);
      await expect(readFile(join(t.dir, "compose.yaml"), "utf8")).rejects.toThrow();
    }
  });
});
