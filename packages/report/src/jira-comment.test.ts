import { describe, expect, it } from "vitest";
import { renderCommentPreview, renderJiraAdf, renderJiraWiki, type CommentModel } from "./jira-comment.js";

const model: CommentModel = {
  ticket: "DEMO-1",
  runId: "20261003-1046-aaaa",
  date: "2026-10-03T11:00:00Z",
  environment: { name: "staging", baseUrl: "https://staging.example.com", deployedSha: "abc1234" },
  repos: { shop: "1".repeat(40) },
  executor: "qa-lead",
  planVersion: 2,
  planSha256: "f".repeat(64),
  rows: [
    {
      caseId: "TC-01",
      title: "Cart total | rounded",
      requirement: "AC1",
      type: "api",
      status: "FAILED",
      stepsPassed: 0,
      stepsTotal: 1,
      evidence: "2 file(s)",
    },
    {
      caseId: "TC-02",
      title: "Codes never stack",
      requirement: "AC3",
      type: "api",
      status: "PASSED",
      stepsPassed: 2,
      stepsTotal: 2,
      evidence: "3 file(s)",
    },
  ],
  summary: "2 cases: 1 PASSED, 1 FAILED.",
  failures: [
    {
      caseId: "TC-01",
      title: "Cart total | rounded",
      status: "FAILED",
      stepId: "S1",
      field: "fields.total",
      expected: 1.01,
      actual: 1.02,
      attachments: ["TC-01_S1.png"],
    },
  ],
  reproduce: "qajitsu evidence DEMO-1 --run 20261003-1046-aaaa --failed",
  attachments: ["DEMO-1_20261003-1046-aaaa_evidence.zip", "TC-01_S1.png"],
  notes: ["video.webm (52 MB) is larger than the 10 MB limit and stays in the run folder."],
};

describe("Jira comment (REQ-PUB-01, REQ-PUB-03)", () => {
  it("REQ-PUB-01/AC1-AC4 + REQ-PUB-03/AC1: ADF with header, matrix, failures and reproduction command", () => {
    const adf = renderJiraAdf(model);
    const json = JSON.stringify(adf);
    expect(adf).toMatchObject({ version: 1, type: "doc" });
    expect(json).toContain("QAJitsu test results: 2 cases: 1 PASSED, 1 FAILED");
    expect(json).toContain("Run 20261003-1046-aaaa");
    expect(json).toContain("Environment: staging (https://staging.example.com), deployed abc1234");
    expect(json).toContain(`Tested code: shop@${"1".repeat(12)}`);
    expect(json).toContain("Plan v2 (sha256 ffffffffffff) · executed by qa-lead");
    expect(json).toContain('{"type":"text","text":"1.01","marks":[{"type":"code"}]}');
    expect(json).toContain(" (see TC-01_S1.png)");
    expect(json).toContain('"type":"codeBlock"');
    expect(json).toContain("qajitsu evidence DEMO-1 --run 20261003-1046-aaaa --failed");
    expect(json).toContain("larger than the 10 MB limit");
    const table = adf.content.find((n) => n["type"] === "table") as { content: unknown[] };
    expect(table.content).toHaveLength(3);
  });

  it("REQ-PUB-03/AC2: wiki markup for Data Center escapes table separators", () => {
    const wiki = renderJiraWiki(model);
    expect(wiki).toContain("h3. QAJitsu test results: 2 cases: 1 PASSED, 1 FAILED");
    expect(wiki).toContain("||TC||Title||Requirement||Type||Status||Steps OK||");
    expect(wiki).toContain("|TC\\-01|Cart total \\| rounded|AC1|API|*FAILED*|0/1|");
    expect(wiki).toContain("{code:shell}qajitsu evidence DEMO-1 --run 20261003-1046-aaaa --failed{code}");
    expect(wiki).toContain("expected {{1.01}}, actual {{1.02}}");
  });

  it("REQ-ENV-05/AC2: stubbed services are named in the header", () => {
    const wiki = renderJiraWiki({
      ...model,
      environment: { ...model.environment, stubs: ["payments (wiremock)"] },
    });
    expect(wiki).toContain("stubbed (not real): payments (wiremock)");
    expect(renderJiraWiki(model)).not.toContain("stubbed");
  });

  it("REQ-VER-10/AC1: a plain preview shows matrix and failures", () => {
    const preview = renderCommentPreview(model);
    expect(preview).toContain("TC-01 | Cart total | rounded | AC1 | API | FAILED | 0/1");
    expect(preview).toContain("TC-01 S1 fields.total: expected 1.01, actual 1.02");
    expect(renderCommentPreview({ ...model, failures: [], attachments: [], notes: [] })).toContain(
      "Attachments: none",
    );
    expect(
      JSON.stringify(renderJiraAdf({ ...model, failures: [], attachments: [], notes: [] })),
    ).not.toContain("Failures");
    expect(renderJiraWiki({ ...model, failures: [], attachments: [], notes: [] })).not.toContain("Failures");
  });
});

describe("failure hints in the Jira comment (REQ-VER-12/AC3)", () => {
  it("REQ-VER-12/AC3: hints appear in their own section as suggestions; the matrix counts stay the computed ones", () => {
    const withHint: CommentModel = {
      ...model,
      rows: model.rows.map((r) =>
        r.caseId === "TC-01" ? { ...r, hint: "product-bug: rounded per line (S1.fields.total)" } : r,
      ),
    };
    const json = JSON.stringify(renderJiraAdf(withHint));
    expect(json).toContain("Failure hints (suggestions, not statuses)");
    expect(json).toContain("TC-01: product-bug: rounded per line (S1.fields.total)");
    expect(json).toContain("QAJitsu test results: 2 cases: 1 PASSED, 1 FAILED");
    expect(renderJiraWiki(withHint)).toContain("h4. Failure hints (suggestions, not statuses)");
    expect(renderCommentPreview(withHint)).toContain(
      "Failure hints (suggestions, not statuses):\n  TC-01: product-bug",
    );
    expect(JSON.stringify(renderJiraAdf(model))).not.toContain("Failure hints");
  });
});
