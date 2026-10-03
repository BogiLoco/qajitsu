import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { renderReportHtml } from "./html.js";
import type { MatrixRow } from "./matrix.js";
import { chooseSummary, templateSummary, validateSummary } from "./summary.js";
import { renderMatrixCsv, renderMatrixXlsx } from "./tables.js";
import { crc32 } from "./zip.js";

const rows: MatrixRow[] = [
  {
    caseId: "TC-01",
    title: "Cart total, rounded",
    requirement: "AC1",
    type: "api",
    status: "PASSED",
    stepsPassed: 1,
    stepsTotal: 1,
    evidence: "2 calls",
  },
  {
    caseId: "TC-02",
    title: '=HYPERLINK("http://evil")',
    requirement: "AC3",
    type: "api",
    status: "FAILED",
    stepsPassed: 1,
    stepsTotal: 2,
    evidence: 'quote "x"',
  },
  {
    caseId: "TC-03",
    title: "Unknown code",
    requirement: "AC4",
    type: "api",
    status: "BLOCKED",
    stepsPassed: 0,
    stepsTotal: 1,
    evidence: "",
  },
];

describe("report formats (REQ-EVD-05)", () => {
  it("REQ-EVD-05/AC2: CSV has a header, escapes quotes and neutralises formulas", () => {
    const csv = renderMatrixCsv(rows);
    expect(csv.split("\r\n")[0]).toBe("TC,Title,Requirement,Type,Status,Steps OK,Steps total,Evidence");
    expect(csv).toContain('TC-01,"Cart total, rounded",AC1,API,PASSED,1,1,2 calls');
    expect(csv).toContain(`TC-02,"'=HYPERLINK(""http://evil"")",AC3,API,FAILED,1,2,"quote ""x"""`);
  });

  it("REQ-EVD-05/AC2: XLSX is a valid ZIP with the workbook parts and the computed summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-xlsx-"));
    try {
      const file = join(dir, "matrix.xlsx");
      await writeFile(file, renderMatrixXlsx(rows));
      const listing = execFileSync("unzip", ["-l", file]).toString();
      for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"])
        expect(listing).toContain(part);
      const sheet = execFileSync("unzip", ["-p", file, "xl/worksheets/sheet1.xml"]).toString();
      expect(sheet).toContain("3 cases: 1 PASSED, 1 FAILED, 1 BLOCKED");
      expect(sheet).toContain("&apos;=HYPERLINK".replace("&apos;", "'"));
      expect(execFileSync("unzip", ["-t", file]).toString()).toContain("No errors detected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("REQ-EVD-05/AC3: report.html is self-contained, escapes text and embeds evidence by hash", () => {
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      cases: rows.map((r) => ({
        id: r.caseId,
        title: r.title,
        type: "api",
        priority: "high",
        source: [{ kind: "ac", id: "AC1" }],
        steps: [
          {
            id: "S1",
            action: "GET /cart",
            expect: { description: "Total <b>1.01</b>", status: 200, fields: { total: 1.01 } },
          },
        ],
        evidence: ["response"],
      })),
    });
    const html = renderReportHtml({
      ticket: "DEMO-1",
      summary: "1 FAILED <script>alert(1)</script>",
      runId: "20261003-1046-aaaa",
      generatedAt: "2026-10-03T11:00:00Z",
      plan,
      planSha256: "f".repeat(64),
      rows,
      attempts: {
        "TC-02": [
          {
            attempt: 1,
            outcome: "failed",
            error: "boom",
            assertions: [{ stepId: "S1", field: "fields.total", expected: 1.01, actual: 1.02, pass: false }],
            evidence: [
              {
                path: "TC-02/attempt-1/S1-01.json",
                sha256: "a".repeat(64),
                kind: "response",
                stepId: "S1",
                text: '{"total":1.02}',
              },
              {
                path: "TC-02/attempt-1/S1.png",
                sha256: "b".repeat(64),
                kind: "screenshot",
                stepId: "S1",
                dataUri: "data:image/png;base64,iVBORw0KGgo=",
              },
              { path: "x.png", sha256: "c".repeat(64), kind: "screenshot", dataUri: "javascript:alert(1)" },
            ],
          },
        ],
      },
      environment: { name: "local", baseUrl: "http://127.0.0.1:3000", deployedSha: "abc123" },
      repos: { shop: "1".repeat(40) },
      gates: [{ gate: "manifest-intact", ok: false, problems: ["x missing"] }],
    });
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<td><code>1.01</code></td><td><code>1.02</code></td>");
    expect(html).toContain('href="../evidence/TC-02/attempt-1/S1-01.json"');
    expect(html).toContain("aaaaaaaaaaaaaaaa…");
    expect(html).toContain('<img alt="TC-02/attempt-1/S1.png" src="data:image/png;base64,iVBORw0KGgo=">');
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("✘ manifest-intact");
    expect(html).toContain("Not run.");
  });
});

describe("summary validation (REQ-VER-08/AC2)", () => {
  it("REQ-VER-08/AC2: accepts a consistent summary", () => {
    expect(
      validateSummary(
        "3 cases ran: 1 PASSED, 1 FAILED, 1 BLOCKED. TC-02 FAILED because the total was 1.02.",
        rows,
      ),
    ).toEqual([]);
  });

  it.each([
    ["3 cases: 2 PASSED, 1 FAILED.", "says 2 PASSED, computed 1"],
    ["PASSED: 3", "says 3 PASSED, computed 1"],
    ["All 4 cases were run.", "says 4 cases, computed 3"],
    ["TC-02 PASSED after a retry.", "says TC-02 is PASSED, computed FAILED"],
    ["TC-09 FAILED.", "mentions TC-09, which is not in the plan"],
  ])("REQ-VER-08/AC2: rejects %j", (text, problem) => {
    expect(validateSummary(text, rows)).toContain(problem);
  });

  it("REQ-VER-08/AC2: an inconsistent LLM summary is replaced by the template", () => {
    expect(chooseSummary("Everything PASSED: 3", rows)).toMatchObject({
      source: "template",
      text: templateSummary(rows),
    });
    expect(chooseSummary(undefined, rows).source).toBe("template");
    expect(chooseSummary("1 FAILED.", rows)).toEqual({ text: "1 FAILED.", source: "llm", problems: [] });
    expect(templateSummary(rows)).toBe(
      '3 cases: 1 PASSED, 1 FAILED, 1 BLOCKED.\nTC-02 FAILED: =HYPERLINK("http://evil").\nTC-03 BLOCKED: Unknown code.',
    );
  });
});
