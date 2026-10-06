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

  /** Adds project "bank" next to demo: same code host and repository, its own ticket, profile and .env.local. */
  const addBank = async (p: Awaited<ReturnType<typeof createBuildProject>>) => {
    const bank = join(p.home, "bank-app");
    await mkdir(join(bank, ".qa", "envs"), { recursive: true });
    await mkdir(join(bank, "tickets"), { recursive: true });
    const ticket = JSON.parse(
      await readFile(new URL("../../examples/demo-shop/tickets/DEMO-1.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(join(bank, "tickets", "BANK-1.json"), JSON.stringify({ ...ticket, key: "BANK-1" }));
    await writeFile(
      join(bank, ".qa", "qa.project.yaml"),
      [
        "project: bank",
        "jira: { type: file, tickets_dir: ../tickets, project_key: BANK }",
        "code_hosts: { local: { type: local, root: ~/git } }",
        "repos: { shop: { host: local, path: demo-org/demo-shop } }",
        "environments: { default: bank, allowlist: ['http://127.0.0.1:9'] }",
        "models: { roles: { default: mock/scripted } }",
        "verification: { auditor: off }",
      ].join("\n"),
    );
    await writeFile(join(bank, ".qa", "envs", "bank.yaml"), "base_url: http://127.0.0.1:9\n");
    await writeFile(join(bank, ".env.local"), "BANK_ONLY_TOKEN=bank-secret-value\n");
    await registerProject(join(p.home, ".qajitsu"), {
      slug: "bank",
      qaDir: join(bank, ".qa"),
      jiraPrefixes: ["BANK"],
    });
    return bank;
  };

  it("REQ-PRJ-03/AC7: runs of different projects execute at the same time, each in its own home", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await addBank(p);
    const [demo, bank] = await Promise.all([
      p.run(["fetch", "DEMO-1"]),
      p.run(["fetch", "BANK-1", "--ref", "shop=main"]),
    ]);
    expect([demo.exitCode, bank.exitCode]).toEqual([0, 0]);
    expect(demo.out.split("\n")[0]).toBe("Project: demo (ticket prefix DEMO)");
    expect(bank.out.split("\n")[0]).toBe("Project: bank (ticket prefix BANK)");
    expect(await readdir(join(p.home, ".qajitsu", "projects", "bank", "runs"))).toEqual(["BANK-1"]);
    expect(await readdir(join(p.home, "runs"))).toEqual(["DEMO-1"]);
  }, 120_000);

  it("REQ-PRJ-04/AC3: secrets, environments and allowlists come from the run's project only", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await addBank(p);
    // Project demo refers to a secret only bank's .env.local holds, and to bank's environment profile.
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(yaml, `${await readFile(yaml, "utf8")}\nsecrets: {}\n`);
    await mkdir(join(p.project, ".qa", "envs"), { recursive: true }).catch(() => undefined);
    await writeFile(
      join(p.project, ".qa", "envs", "leak.yaml"),
      "base_url: http://localhost:3000\naccounts:\n  user:x: { username: x, password: secret://env/BANK_ONLY_TOKEN }\n",
    );
    const demoCheck = await p.run(["env", "check", "--env", "leak"]);
    expect(demoCheck.out).toContain("secret://env/BANK_ONLY_TOKEN cannot be resolved");
    expect(demoCheck.out + demoCheck.err).not.toContain("bank-secret-value");
    expect((await p.run(["env", "check", "--env", "bank"])).out).toContain("environment bank");
    // Bank's own allowlist and profile resolve only in bank.
    const bankCheck = await p.run(["--project", "bank", "env", "check"]);
    expect(bankCheck.out).toContain("Environment profile: bank");
  }, 120_000);
});
