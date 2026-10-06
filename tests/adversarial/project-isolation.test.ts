// Projects are isolated (REQ-PRJ-04, ADR-0006): an agent working in project A cannot read anything of project B,
// whatever path it tries, and nothing of B reaches A's prompts, journal, evidence or reports.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerProject } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../support/cli-build.js";

const CONFIDENTIAL = "BANK-CONFIDENTIAL-4711";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const readAll = async (dir: string): Promise<string> => {
  let text = "";
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    text += await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => "");
  }
  return text;
};

describe("isolation between projects (REQ-PRJ-04)", () => {
  it("REQ-PRJ-04/AC1+AC4: an agent of project A asking for files of project B is denied and journaled; nothing of B leaks into A", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    // Project B, registered next to A in the same QAJitsu home, with a confidential document.
    const qjHome = join(p.home, ".qajitsu");
    const bankQa = join(p.home, "bank-app", ".qa");
    await mkdir(bankQa, { recursive: true });
    await writeFile(
      join(bankQa, "qa.project.yaml"),
      "project: bank\njira: { type: file, tickets_dir: t, project_key: BANK }\n",
    );
    await registerProject(qjHome, { slug: "bank", qaDir: bankQa, jiraPrefixes: ["BANK"] });
    const secretFile = join(qjHome, "projects", "bank", "knowledge", "contracts.md");
    await writeFile(secretFile, `Client contract: ${CONFIDENTIAL}\n`);
    await writeFile(join(bankQa, "notes.md"), `${CONFIDENTIAL}\n`);

    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    const draft = await readFile(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8");
    const plan = await p.run(
      ["plan", "DEMO-1"],
      [
        {
          tools: [
            { name: "read_file", input: { path: secretFile } },
            { name: "read_file", input: { path: "../../../.qajitsu/projects/bank/knowledge/contracts.md" } },
            { name: "read_file", input: { path: "../../../bank-app/.qa/notes.md" } },
            { name: "list_files", input: { path: "/" } },
          ],
        },
        { text: analysis },
        { text: draft },
      ],
    );
    expect(plan.exitCode).toBe(0);
    const runs = join(p.home, "runs", "DEMO-1");
    const index = JSON.parse(await readFile(join(runs, "index.json"), "utf8")) as { latest: string };
    const runDir = join(runs, index.latest);
    const journal = await readFile(join(runDir, "journal", "events.jsonl"), "utf8");
    expect(journal.match(/"tool_denied"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(journal).toContain("OUTSIDE_WORKSPACE");
    // Nothing of project B anywhere in project A's run: journal, plan, analysis, logs.
    expect(await readAll(runDir)).not.toContain(CONFIDENTIAL);
    expect(plan.out + plan.err).not.toContain(CONFIDENTIAL);
  }, 120_000);

  it("REQ-PRJ-04/AC3 + REQ-PRJ-03/AC6: a run of one project cannot be continued under another", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const bankQa = join(p.home, "bank-app", ".qa");
    await mkdir(bankQa, { recursive: true });
    await writeFile(
      join(bankQa, "qa.project.yaml"),
      "project: bank\njira: { type: file, tickets_dir: t, project_key: BANK }\nworkspace: { root: ~/runs }\n",
    );
    await registerProject(join(p.home, ".qajitsu"), { slug: "bank", qaDir: bankQa, jiraPrefixes: ["BANK"] });
    // Both projects point at the same run folder root on purpose; the run still belongs to demo.
    const other = await p.run(["--project", "bank", "run", "DEMO-1", "--run", dir.split("/").at(-1) ?? ""]);
    expect(other.exitCode).toBe(3);
    expect(other.err).toContain("[RUN_OTHER_PROJECT]");
  }, 120_000);
});
