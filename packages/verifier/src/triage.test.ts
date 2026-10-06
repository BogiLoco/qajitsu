import type { CaseResultFile } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkTriageHints, type TriageEvidence } from "./triage.js";

const result: CaseResultFile = {
  schema: 1,
  caseId: "TC-01",
  runner: "api",
  attempts: [
    {
      attempt: 1,
      outcome: "failed",
      assertions: [{ stepId: "S1", field: "status", expected: 200, actual: 500, pass: false }],
      steps: [{ id: "S1", ok: false, error: "HTTP 500" }],
      evidence: ["TC-01/attempt-1/S1-response.json"],
    },
  ],
} as unknown as CaseResultFile;

const evidence: TriageEvidence = {
  results: new Map([["TC-01", result]]),
  manifest: ["TC-01/attempt-1/S1-response.json", "TC-02/attempt-1/S1.png"],
  logs: ["services/api.log"],
  failed: ["TC-01"],
};

describe("triage hints are checked by code (REQ-VER-12)", () => {
  it("REQ-VER-12/AC1+AC2: keeps only citations that exist for that case; a hint without any is dropped", () => {
    const out = checkTriageHints(
      [
        {
          caseId: "TC-01",
          category: "product-bug",
          justification: "The API answered 500 in S1.",
          cites: [
            { kind: "assertion", ref: "S1.status" },
            { kind: "evidence", ref: "TC-01/attempt-1/S1-response.json" },
            { kind: "log", ref: "services/api.log" },
            { kind: "step", ref: "S9" },
            { kind: "evidence", ref: "TC-02/attempt-1/S1.png" },
          ],
        },
        {
          caseId: "TC-01",
          category: "data",
          justification: "duplicate hint for the same case",
          cites: [{ kind: "step", ref: "S1" }],
        },
        {
          caseId: "TC-02",
          category: "test-bug",
          justification: "not a FAILED case",
          cites: [{ kind: "step", ref: "S1" }],
        },
      ],
      evidence,
    );
    expect(out.hints).toEqual([
      {
        caseId: "TC-01",
        category: "product-bug",
        justification: "The API answered 500 in S1.",
        cites: [
          { kind: "assertion", ref: "S1.status" },
          { kind: "evidence", ref: "TC-01/attempt-1/S1-response.json" },
          { kind: "log", ref: "services/api.log" },
        ],
      },
    ]);
    expect(out.dropped).toEqual(["TC-02"]);
  });

  it("REQ-VER-12/AC2: a hint citing only invented evidence is dropped", () => {
    const out = checkTriageHints(
      [
        {
          caseId: "TC-01",
          category: "environment",
          justification: "The database was down.",
          cites: [
            { kind: "log", ref: "services/db.log" },
            { kind: "evidence", ref: "../../etc/passwd" },
          ],
        },
      ],
      evidence,
    );
    expect(out).toEqual({ hints: [], dropped: ["TC-01"] });
  });
});
