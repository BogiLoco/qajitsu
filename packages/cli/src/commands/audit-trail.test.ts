import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { unzip } from "@qajitsu/report";
import { sha256 } from "@qajitsu/core";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("audit trail of a run (REQ-VER-16)", () => {
  it("REQ-VER-16/AC1+AC2+AC4: an executed run has a complete trail with every model exchange; editing a stored exchange is a gap", async () => {
    const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING" });
    cleanups.push(p.cleanup);
    await p.executed();

    // Every model call of the run is in the transcript, and the journal points to it.
    const transcript = await readFile(join(p.runDir, "journal", "agents.jsonl"), "utf8");
    const exchanges = transcript
      .trim()
      .split("\n")
      .map(
        (l) => JSON.parse(l) as { seq: number; role: string; request: unknown; response: { text: string } },
      );
    expect(exchanges.map((e) => e.role)).toEqual(expect.arrayContaining(["analyst", "planner"]));
    expect(exchanges.map((e) => e.seq)).toEqual(exchanges.map((_, i) => i + 1));
    expect(exchanges.every((e) => e.response.text.length > 0)).toBe(true);

    const trail = await p.run(["audit", "trail", "DEMO-1"]);
    expect(trail.err).toBe("");
    expect(trail.out).toContain("✔ The audit trail is complete.");
    expect(trail.out).toMatch(/files \(.*agents 1.*\)/);
    expect(trail.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(join(p.runDir, "audit", "trail.json"), "utf8")) as {
      complete: boolean;
      files: { path: string; sha256: string }[];
      records: { approval: { sha256: string }; versions: unknown; environment: unknown };
    };
    expect(doc.complete).toBe(true);
    expect(doc.records.approval.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "ticket/ticket.json",
        "plan/plan.approved.yaml",
        "specs/TC-01.spec.ts",
        "results/TC-01.json",
        "evidence/manifest.json",
        "report/report.html",
        "journal/events.jsonl",
        "journal/agents.jsonl",
      ]),
    );
    // The env folder with its secrets is never part of the trail.
    expect(doc.files.some((f) => f.path.startsWith("env/"))).toBe(false);

    // Someone edits a stored answer after the run: the trail is no longer complete.
    await writeFile(
      join(p.runDir, "journal", "agents.jsonl"),
      transcript.replace(/"role":"planner"/, '"role":"plannr"'),
    );
    const broken = await p.run(["audit", "trail", "DEMO-1"]);
    expect(broken.exitCode).toBe(1);
    expect(broken.out).toContain("no certificate can be issued until they are fixed");
    expect(broken.out).toMatch(/model exchange [0-9a-f]{12} is not in journal\/agents.jsonl/);
  }, 180_000);

  it("REQ-VER-16/AC5: the export is one zip readable without QAJitsu: files, trail, SHA256SUMS and a README", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.executed();
    const exported = await p.run(["audit", "export", "DEMO-1", "--out", "audit.zip"]);
    expect(exported.err).toBe("");
    expect(exported.exitCode).toBe(0);
    expect(exported.out).toContain("Audit archive:");
    const files = unzip(new Uint8Array(await readFile(join(p.project, "audit.zip"))));
    const names = files.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["README.txt", "SHA256SUMS", "audit/trail.json", "run.json"]),
    );
    expect(names.some((n) => n.startsWith("env/"))).toBe(false);
    // Every line of SHA256SUMS matches the file in the archive, as sha256sum -c would check.
    const sums = new TextDecoder()
      .decode(files.find((f) => f.name === "SHA256SUMS")?.data)
      .trim()
      .split("\n");
    expect(sums.length).toBe(names.length - 2);
    for (const line of sums) {
      const [hash, name] = line.split("  ");
      expect(sha256(files.find((f) => f.name === name)?.data ?? new Uint8Array()), name).toBe(hash);
    }
    expect(new TextDecoder().decode(files.find((f) => f.name === "README.txt")?.data)).toContain(
      "sha256sum -c SHA256SUMS",
    );
  }, 180_000);
});
