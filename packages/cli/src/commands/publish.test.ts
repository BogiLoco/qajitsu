import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const pipeline = async (flag?: string) => {
  const p = await createDemoPipeline(flag ? { flag } : {});
  cleanups.push(p.cleanup);
  return p;
};
interface PublishData {
  data: { publish: { commentId: string; preview: string; attachmentNames: string[] } };
}

describe("qajitsu publish (REQ-PUB-01..04, REQ-VER-10)", () => {
  it("REQ-VER-10/AC1 + REQ-PUB-01 + REQ-PUB-02/AC1: shows a preview, publishes after confirmation, attaches the evidence zip", async () => {
    const { run, runDir, executed } = await pipeline("BUG_CART_TOTAL_ROUNDING");
    expect((await executed()).exitCode).toBe(1);
    const declined = await run(["publish", "DEMO-1"], { ask: ["n"] });
    expect(declined.out).toContain("QAJitsu test results: 2 cases: 1 PASSED, 1 FAILED");
    expect(declined.out).toContain("Not published.");
    const result = await run(["publish", "DEMO-1"], { ask: ["y"] });
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("TC-01 S1 fields.total: expected 1.01, actual 1.02");
    expect(result.out).toContain("Published DEMO-1 comment local-20261003-1046-aaaa");
    const adf = await readFile(join(runDir, "report", "published", "jira-comment.adf.json"), "utf8");
    expect(adf).toContain("qajitsu evidence DEMO-1 --run 20261003-1046-aaaa --failed");
    expect(adf).not.toContain(DEMO_PASSWORD);
    const zip = join(runDir, "report", "DEMO-1_20261003-1046-aaaa_evidence.zip");
    const listing = execFileSync("unzip", ["-l", zip]).toString();
    expect(listing).toContain("evidence/manifest.json");
    expect(listing).toContain("report/report.html");
    const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as PublishData;
    expect(record.data.publish).toMatchObject({
      commentId: "local-20261003-1046-aaaa",
      preview: "confirmed",
      attachmentNames: ["DEMO-1_20261003-1046-aaaa_evidence.zip"],
    });
  });

  it("REQ-VER-10/AC2: CI needs --auto-publish; the choice is recorded. REQ-PUB-04/AC1: republishing updates", async () => {
    const { run, runDir, executed } = await pipeline();
    await executed();
    const ci = await run(["publish", "DEMO-1"]);
    expect(ci.exitCode).toBe(3);
    expect(ci.err).toContain("[PUBLISH_PREVIEW_REQUIRED]");
    expect((await run(["publish", "DEMO-1", "--auto-publish"])).out).toContain("Published");
    const again = await run(["publish", "DEMO-1", "--auto-publish"]);
    expect(again.out).toContain("Updated DEMO-1 comment local-20261003-1046-aaaa");
    const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as PublishData;
    expect(record.data.publish.preview).toBe("auto");
  });

  it("REQ-VER-07: results tampered with after the run are not published", async () => {
    const { run, runDir, executed } = await pipeline("BUG_CART_TOTAL_ROUNDING");
    await executed();
    const file = join(runDir, "results", "TC-01.json");
    const tampered = (await readFile(file, "utf8"))
      .replaceAll('"pass": false', '"pass": true')
      .replaceAll('"outcome": "failed"', '"outcome": "passed"');
    await writeFile(file, tampered);
    const evidence = join(runDir, "evidence", "TC-01", "attempt-1", "S1-02.json");
    await writeFile(evidence, (await readFile(evidence, "utf8")).replace("1.02", "1.01"));
    const result = await run(["publish", "DEMO-1", "--auto-publish"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("[PUBLISH_GATES_FAILED]");
    expect(result.err).toContain("manifest-intact");
  });

  it("refuses runs without results", async () => {
    const { run } = await pipeline();
    await run(["fetch", "DEMO-1"]);
    expect((await run(["publish", "DEMO-1", "--auto-publish"])).err).toContain("[RUN_NOT_EXECUTED]");
  });

  it("REQ-PUB-01/AC4: qj evidence --failed shows failed assertions, files and cURL", async () => {
    const { run, executed } = await pipeline("BUG_CART_TOTAL_ROUNDING");
    await executed();
    const result = await run(["evidence", "DEMO-1", "--failed"]);
    expect(result.out).toContain("TC-01 FAILED");
    expect(result.out).toContain("✘ S1 fields.total: expected 1.01, actual 1.02");
    expect(result.out).toContain("curl -X GET");
    expect(result.out).not.toContain("TC-02 PASSED");
    expect(result.out).not.toContain(DEMO_PASSWORD);
    expect((await run(["evidence", "DEMO-1", "--case", "TC-02"])).out).toContain("TC-02 PASSED");
    expect((await run(["evidence", "DEMO-1", "--case", "TC-09"])).out).toContain("No matching cases.");
  });

  it("REQ-PUB-03/AC1: publishes to Jira Cloud with credentials from .env.local and stores the comment id", async () => {
    const { run, runDir, executed, project } = await pipeline();
    await executed();
    const yaml = join(project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "jira: { type: file, tickets_dir: ../tickets, project_key: DEMO }",
        "jira: { type: cloud, base_url: 'https://jira.example.com', email: secret://env/JIRA_EMAIL, token: secret://env/JIRA_TOKEN, project_key: DEMO }",
      ),
    );
    await writeFile(
      join(project, ".env.local"),
      "JIRA_EMAIL=qa@example.com\nJIRA_TOKEN=jira-cloud-token-123456\n",
    );
    const calls: { url: string; method: string; auth: string }[] = [];
    const fakeJira: typeof globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "jira.example.com") return globalThis.fetch(input, init);
      calls.push({
        url: url.pathname,
        method: init?.method ?? "GET",
        auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "",
      });
      const body = url.pathname.endsWith("/attachments")
        ? [{ id: 900, filename: "DEMO-1_20261003-1046-aaaa_evidence.zip" }]
        : { id: "20001" };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } }),
      );
    };
    const result = await run(["publish", "DEMO-1", "--auto-publish"], { fetch: fakeJira });
    expect(result.err).toBe("");
    expect(result.out).toContain(
      "Published DEMO-1 comment 20001: https://jira.example.com/browse/DEMO-1?focusedCommentId=20001",
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /rest/api/3/issue/DEMO-1/comment",
      "POST /rest/api/3/issue/DEMO-1/attachments",
    ]);
    expect(calls[0]?.auth.startsWith("Basic ")).toBe(true);
    const runJson = await readFile(join(runDir, "run.json"), "utf8");
    expect(runJson).toContain('"commentId": "20001"');
    expect(runJson).not.toContain("jira-cloud-token-123456");
    const updated = await run(["publish", "DEMO-1", "--auto-publish"], { fetch: fakeJira });
    expect(updated.out).toContain("Updated DEMO-1 comment 20001");
    expect(calls.at(-1)).toMatchObject({ method: "PUT", url: "/rest/api/3/issue/DEMO-1/comment/20001" });
  });

  it("stage-4 review: a file in evidence/ that is not in the manifest blocks publishing", async () => {
    const { run, runDir, executed } = await pipeline();
    await executed();
    await writeFile(join(runDir, "evidence", "TC-01", "debug.json"), '{"token":"sneaky"}');
    const result = await run(["publish", "DEMO-1", "--auto-publish"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("evidence-listed");
  });

  it("stage-4 review: a manifest entry pointing outside evidence/ is rejected", async () => {
    const { run, runDir, executed } = await pipeline();
    await executed();
    const manifestFile = join(runDir, "evidence", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>[];
    manifest.push({ ...manifest[0], path: "../run.json", kind: "video" });
    await writeFile(manifestFile, JSON.stringify(manifest));
    const result = await run(["publish", "DEMO-1", "--auto-publish"]);
    expect(result.exitCode).toBe(3);
    expect(result.err).toContain("EVIDENCE_MANIFEST_INVALID");
  });

  it("stage-4 review: declining the preview is exit code 2 (not published)", async () => {
    const { run, executed } = await pipeline();
    await executed();
    expect((await run(["publish", "DEMO-1"], { ask: ["n"] })).exitCode).toBe(2);
  });
});
