import { describe, expect, it } from "vitest";
import { renderJiraWiki, renderCommentPreview, type CommentModel } from "./jira-comment.js";
import { collectObservations } from "./observations.js";

const file = JSON.stringify({
  console: [{ level: "error", text: "cart total is NaN", url: "/app/cart" }],
  http: [
    { method: "GET", url: "/api/recommendations", status: 500 },
    { method: "GET", url: "/favicon.ico", status: 404 },
  ],
  accessibility: [
    {
      rule: "image-alt",
      impact: "critical",
      help: "Images must have alternative text",
      url: "/app/cart",
      targets: ["img.logo"],
    },
  ],
});

describe("passive observations (REQ-EVD-07)", () => {
  it("REQ-EVD-07/AC1+AC2+AC3: collects contract mismatches, console errors, 4xx/5xx and accessibility violations per case", () => {
    const observed = collectObservations([
      {
        caseId: "TC-01",
        assertions: [
          { stepId: "S1", field: "openapi", actual: "GET /cart 200: /total must be number", pass: false },
          { stepId: "S1", field: "status", actual: 200, pass: true },
        ],
        observationsFile: file,
      },
      { caseId: "TC-02", assertions: [], observationsFile: "not json" },
    ]);
    expect(observed).toEqual([
      { caseId: "TC-01", kind: "openapi", text: "S1: GET /cart 200: /total must be number" },
      { caseId: "TC-01", kind: "console", text: "/app/cart: cart total is NaN" },
      { caseId: "TC-01", kind: "http", text: "GET /api/recommendations → 500" },
      { caseId: "TC-01", kind: "http", text: "GET /favicon.ico → 404" },
      {
        caseId: "TC-01",
        kind: "accessibility",
        text: "/app/cart: image-alt (critical) Images must have alternative text [img.logo]",
      },
    ]);
  });

  it("REQ-EVD-07/AC5: the ignore list drops matching observations; duplicates are merged", () => {
    const observed = collectObservations(
      [
        { caseId: "TC-01", assertions: [], observationsFile: file },
        { caseId: "TC-01", assertions: [], observationsFile: file },
      ],
      ["favicon.ico", "image-alt"],
    );
    expect(observed.map((o) => o.kind)).toEqual(["console", "http"]);
  });

  it("REQ-EVD-07/AC4: the Jira comment lists observations in their own section; the counts stay those of the results", () => {
    const model: CommentModel = {
      ticket: "DEMO-4",
      runId: "r",
      date: "d",
      environment: { name: "local", baseUrl: "http://127.0.0.1:3000" },
      repos: {},
      executor: "qa",
      planVersion: 1,
      planSha256: "a".repeat(64),
      rows: [
        {
          caseId: "TC-01",
          title: "t",
          requirement: "AC1",
          type: "web",
          status: "PASSED",
          stepsPassed: 1,
          stepsTotal: 1,
          evidence: "",
        },
      ],
      summary: "s",
      failures: [],
      reproduce: "qj evidence",
      attachments: [],
      notes: [],
      observations: collectObservations([{ caseId: "TC-01", assertions: [], observationsFile: file }]),
    };
    const wiki = renderJiraWiki(model);
    expect(wiki).toContain("h3. QAJitsu test results: 1 case: 1 PASSED");
    expect(wiki).toContain("h4. Observations (found by code, not test results)");
    expect(wiki).toContain("TC\\-01 http: GET /api/recommendations → 500");
    expect(renderCommentPreview(model)).toContain("Observations (found by code, not test results):");
    const quiet = renderJiraWiki({ ...model, observations: [] });
    expect(quiet).not.toContain("Observations");
  });
});
