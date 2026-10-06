import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { apiService, createBuildProject, PASSWORD } from "../../../../tests/support/cli-build.js";
import { createFakeEmbedder } from "../../../../tests/support/fake-embedder.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A token-shaped value built at runtime, so no credential-like literal sits in the repository. */
const FAKE_GITHUB_TOKEN = ["gh", "p_", "a1b2c3d4e5".repeat(4)].join("");

const setup = async () => {
  const embedder = createFakeEmbedder();
  const p = await createBuildProject(apiService(), {
    ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }) },
  });
  cleanups.push(p.cleanup);
  await mkdir(join(p.project, "docs"));
  await writeFile(
    join(p.project, "docs", "orders.md"),
    "# Orders\nA paid order can be cancelled within 24 hours.\n",
  );
  expect((await p.run(["knowledge", "add", "docs", "--tag", "api"])).exitCode).toBe(0);
  const other = await mkdtemp(join(tmpdir(), "qj-other-machine-"));
  cleanups.push(() => rm(other, { recursive: true, force: true }));
  return { ...p, other, exports: join(p.home, ".qajitsu", "projects", "demo", "exports") };
};

describe("project profile export and import (REQ-PRJ-09)", () => {
  it("REQ-PRJ-09/AC1: export writes the profile, the .qa/ text files and the knowledge sources; no index, keys or secrets", async () => {
    const p = await setup();
    await writeFile(join(p.project, ".qa", ".env"), "TOKEN=abc");
    await writeFile(join(p.project, ".qa", "hooks", "client.pem"), "-----BEGIN CERTIFICATE-----");
    const out = await p.run(["projects", "export", "demo"]);
    expect(out.exitCode).toBe(0);
    expect(out.out).toContain("knowledge source(s); no index, runs or secrets.");
    expect(out.out).toContain("left out .qa/.env: environment, key or credential file");
    expect(out.out).toContain("left out .qa/hooks/client.pem");
    const text = await readFile(join(p.exports, "demo.profile.yaml"), "utf8");
    const profile = parse(text) as {
      qa_files: { path: string }[];
      knowledge_sources: { name: string; tags: string[] }[];
    };
    expect(profile.qa_files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["qa.project.yaml", "envs/local.yaml", "hooks/seed.mjs"]),
    );
    expect(profile.qa_files.map((f) => f.path)).not.toContain(".env");
    expect(profile.knowledge_sources).toMatchObject([{ name: "docs", tags: ["api"] }]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("cancelled within 24 hours");
    expect(text).not.toContain("synced_at");
  }, 120_000);

  it("REQ-PRJ-09/AC1: a .qa/ file with a secret value or a credential is never exported", async () => {
    const p = await setup();
    await writeFile(join(p.project, ".qa", "accounts.md"), `Log in with ${PASSWORD}\n`);
    const refused = await p.run(["projects", "export", "demo"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("[PROFILE_CONTAINS_SECRET]");
    expect(refused.err).toContain("accounts.md");
    expect(refused.err).not.toContain(PASSWORD);
    await rm(join(p.project, ".qa", "accounts.md"));
    await writeFile(join(p.project, ".qa", "notes.md"), `ci token ${FAKE_GITHUB_TOKEN}\n`);
    expect((await p.run(["projects", "export", "demo"])).err).toContain(
      "notes.md contains a secret value or a credential",
    );
    expect(await readdir(p.exports).catch(() => [])).not.toContain("demo.profile.yaml");
  }, 120_000);

  it("REQ-PRJ-09/AC2: import on another machine recreates .qa/, the project and its sources; sync rebuilds the knowledge base", async () => {
    const p = await setup();
    const file = join(p.other, "demo.profile.yaml");
    expect((await p.run(["projects", "export", "demo", "--out", file])).exitCode).toBe(0);
    // Another machine: its own QAJitsu home, the repository cloned elsewhere.
    const env = { QAJITSU_HOME: join(p.other, "home") };
    const clone = join(p.other, "code", "shop");
    await mkdir(join(clone, "docs"), { recursive: true });
    await writeFile(
      join(clone, "docs", "orders.md"),
      "# Orders\nA paid order can be cancelled within 24 hours.\n",
    );
    const imported = await p.run(
      ["projects", "import", file, "--qa-dir", join(clone, ".qa"), "--map-path", `${p.project}=${clone}`],
      undefined,
      { env },
    );
    expect(imported.err).toBe("");
    expect(imported.exitCode).toBe(0);
    expect(imported.out).toMatch(
      /Imported project demo: wrote \d+ \.qa\/ file\(s\) to .*code\/shop\/\.qa, 1 knowledge source\(s\)\./,
    );
    expect(await readFile(join(clone, ".qa", "qa.project.yaml"), "utf8")).toContain("project_key: DEMO");
    const sources = await readFile(
      join(p.other, "home", "projects", "demo", "knowledge", "sources.yaml"),
      "utf8",
    );
    expect(sources).toContain(join(clone, "docs"));
    const synced = await p.run(["--project", "demo", "knowledge", "sync"], undefined, { env });
    expect(synced.out).toContain("1 added");
    expect(
      (await p.run(["--project", "demo", "knowledge", "search", "cancel paid order"], undefined, { env }))
        .out,
    ).toContain("docs/orders.md › Orders");
    // Importing again over the existing .qa/ links it; the slug can change. Without --map-path the knowledge
    // source points at the old machine: exit 2 with the fix.
    await rm(join(p.project, "docs"), { recursive: true });
    const again = await p.run(
      ["projects", "import", file, "--qa-dir", join(clone, ".qa"), "--slug", "shop-copy"],
      undefined,
      { env },
    );
    expect(again.out).toContain("linked the existing .qa/");
    expect(again.exitCode).toBe(2);
    expect(again.out).toContain("missing knowledge source docs");
  }, 180_000);

  it("REQ-PRJ-09/AC2: profiles that escape .qa/, are not profiles, or clash with an existing project are refused", async () => {
    const p = await setup();
    const evil = join(p.other, "evil.yaml");
    await writeFile(
      evil,
      stringify({
        schema: 1,
        kind: "qajitsu-project-profile",
        exported_at: "2026-10-06T00:00:00Z",
        slug: "evil",
        qa_dir: "/tmp/x",
        qa_files: [{ path: "../../.bashrc", text: "echo pwned" }],
      }),
    );
    const refused = await p.run(["projects", "import", evil, "--qa-dir", join(p.other, "qa")]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("[PROFILE_INVALID]");
    await expect(readFile(join(p.other, ".bashrc"), "utf8")).rejects.toThrow();
    await writeFile(join(p.other, "random.yaml"), "hello: world\n");
    expect((await p.run(["projects", "import", join(p.other, "random.yaml")])).err).toContain(
      "[PROFILE_INVALID]",
    );
    await p.run(["projects", "export", "demo"]);
    const profile = join(p.exports, "demo.profile.yaml");
    expect((await p.run(["projects", "import", profile])).err).toContain("[PROJECT_EXISTS]");
    expect((await p.run(["projects", "import", profile, "--map-path", "nope"])).err).toContain(
      "[MAP_PATH_INVALID]",
    );
  }, 120_000);
});
