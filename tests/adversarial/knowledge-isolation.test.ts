// Adversarial suite: an agent tries to reach another project's documentation or to forge documentation sources.
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkId } from "@qajitsu/core";
import { createGuard, createJournal, DEFAULT_PROTECTED_PATHS } from "@qajitsu/guard";
import { afterEach, describe, expect, it } from "vitest";
import { analysis, apiService, createBuildProject, draft } from "../support/cli-build.js";
import { createFakeEmbedder } from "../support/fake-embedder.js";
import { promptOf } from "../support/mock-model.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const MARKER = "Client B settlement accounts use the hidden ledger";

/** Project `demo` with its own docs, project `other` with confidential docs, sharing one QAJitsu home. */
const twoProjects = async () => {
  const embedder = createFakeEmbedder();
  const p = await createBuildProject(apiService(), {
    ports: { embedder: (ref) => Promise.resolve({ ...embedder, id: ref }) },
  });
  cleanups.push(p.cleanup);
  await mkdir(join(p.project, "docs"));
  await writeFile(
    join(p.project, "docs", "cart.md"),
    "# Cart\nThe cart total is rounded once after summing lines.\n",
  );
  await mkdir(join(p.home, "client-b"));
  await writeFile(
    join(p.home, "client-b", "ledger.md"),
    `# Ledger\n${MARKER} for cart totals and settlement.\n`,
  );
  expect((await p.run(["knowledge", "add", "docs"])).exitCode).toBe(0);
  expect(
    (await p.run(["init", "other", "--qa-dir", join(p.project, ".qa"), "--yes", "--no-use"])).exitCode,
  ).toBeLessThan(3);
  expect((await p.run(["--project", "other", "knowledge", "add", join(p.home, "client-b")])).exitCode).toBe(
    0,
  );
  expect((await p.run(["--project", "demo", "fetch", "DEMO-1"])).exitCode).toBe(0);
  const runDir = async () => {
    const id =
      (await readdir(join(p.home, "runs", "DEMO-1")))
        .filter((f) => /^\d{8}-/.test(f))
        .sort()
        .at(-1) ?? "";
    return join(p.home, "runs", "DEMO-1", id);
  };
  return { ...p, runDir };
};

const citing = (source: Record<string, unknown>): string => {
  const plan = JSON.parse(draft) as { cases: { source: unknown[] }[] };
  plan.cases[0]?.source.push({ kind: "doc", ...source });
  return JSON.stringify(plan);
};

describe("knowledge isolation and forged documentation sources (REQ-KNOW-09/AC3, REQ-PRJ-04/AC2, REQ-KNOW-06/AC3)", () => {
  it("REQ-KNOW-09/AC3 + REQ-PRJ-04/AC2: search_docs of a run in project A never returns, prompts or snapshots project B's documents", async () => {
    const p = await twoProjects();
    // Project B's document is really indexed and found from B.
    expect(
      (await p.run(["--project", "other", "knowledge", "search", "hidden ledger settlement"])).out,
    ).toContain("client-b/ledger.md");
    const planned = await p.run(
      ["--project", "demo", "plan", "DEMO-1"],
      [
        { text: analysis },
        { tools: [{ name: "search_docs", input: { query: "hidden ledger settlement client B" } }] },
        { text: draft },
      ],
    );
    expect(planned.exitCode).toBe(0);
    for (let n = 0; n < planned.model.mock.doGenerateCalls.length; n++)
      expect(promptOf(planned.model, n)).not.toContain("settlement accounts");
    const snapshot = await readFile(join(await p.runDir(), "knowledge", "chunks.json"), "utf8");
    expect(snapshot).not.toContain("settlement accounts");
    expect(promptOf(planned.model, 2)).toContain("No matching documentation.");
    const journal = await readFile(join(await p.runDir(), "journal", "events.jsonl"), "utf8");
    expect(journal).not.toContain(chunkId("client-b/ledger.md", 0));
  }, 180_000);

  it("REQ-KNOW-06/AC3: citing project B's chunk id, or claiming another file for a real chunk, is rejected by code", async () => {
    const p = await twoProjects();
    const foreign = await p.run(
      ["--project", "demo", "plan", "DEMO-1"],
      [{ text: analysis }, { text: citing({ chunk: chunkId("client-b/ledger.md", 0), quote: MARKER }) }],
    );
    expect(foreign.exitCode).toBe(3);
    expect(foreign.err).toContain("no such documentation chunk");
    const misattributed = await p.run(
      ["--project", "demo", "plan", "DEMO-1"],
      [
        {
          text: citing({
            chunk: chunkId("docs/cart.md", 0),
            quote: "The cart total is rounded once",
            path: "docs/security-policy.md",
          }),
        },
      ],
    );
    expect(misattributed.exitCode).toBe(3);
    expect(misattributed.err).toContain(`is from docs/cart.md, not docs/security-policy.md`);
  }, 180_000);

  it("REQ-KNOW-06/AC3: an agent cannot rewrite the run's documentation snapshot to make a forged quote pass", () => {
    const lines: string[] = [];
    const journal = createJournal(
      (l) => lines.push(l),
      () => new Date("2026-10-06T10:00:00Z"),
      (v) => v,
    );
    const guard = createGuard({
      run: "20261006-1000-abcd",
      stage: "author",
      journal,
      policy: {
        workspaceRoot: "/runs/DEMO-1/20261006-1000-abcd",
        allowedTools: new Set(["write_file"]),
        writeTools: new Set(["write_file"]),
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        networkTools: new Set(),
        allowedOrigins: [],
      },
    });
    const decision = guard.check({
      tool: "write_file",
      input: { path: "knowledge/chunks.json", content: "{}" },
    });
    expect(decision.allowed).toBe(false);
    expect(lines.join("\n")).toContain("knowledge/chunks.json");
  });
});
