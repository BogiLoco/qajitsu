import type { BlockedHint, CaseResultFile } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkBlockedHints, type BlockedEvidence } from "./blocked.js";

const result = (caseId: string, error?: string): CaseResultFile =>
  ({
    schema: 1,
    caseId,
    runner: "api",
    attempts: [
      {
        attempt: 1,
        outcome: "error",
        assertions: [],
        steps: [{ id: "S1", ok: false, error: "x" }],
        evidence: [`${caseId}/attempt-1/page-source.xml`],
        ...(error ? { error } : {}),
      },
    ],
  }) as unknown as CaseResultFile;

const evidence: BlockedEvidence = {
  results: new Map([
    ["TC-01", result("TC-01", "ui.as is not available in native apps")],
    ["TC-02", result("TC-02")],
    ["TC-03", result("TC-03", "author could not produce a valid spec")],
  ]),
  manifest: ["TC-01/attempt-1/page-source.xml", "TC-02/attempt-1/page-source.xml"],
  logs: ["appium.log"],
  specs: { "TC-01": 'line 1\nline 2\nawait ui.as("user:standard");\n' },
  blocked: ["TC-01", "TC-02", "TC-03"],
};

const hint = (caseId: string, cites: BlockedHint["cites"]): BlockedHint => ({
  caseId,
  category: "spec",
  justification: "The spec logs in with ui.as, which a native app does not have.",
  next: "Run again: the author now writes native steps.",
  cites,
});

describe("hints for BLOCKED cases are checked by code (REQ-VER-13)", () => {
  it("REQ-VER-13/AC1+AC2: keeps citations that exist: steps, evidence of the case, logs, spec lines and the error", () => {
    const out = checkBlockedHints(
      [
        hint("TC-01", [
          { kind: "spec", ref: "3" },
          { kind: "error", ref: "error" },
          { kind: "step", ref: "S1" },
          { kind: "evidence", ref: "TC-01/attempt-1/page-source.xml" },
          { kind: "log", ref: "appium.log" },
          { kind: "spec", ref: "99" },
          { kind: "spec", ref: "two" },
          { kind: "evidence", ref: "TC-02/attempt-1/page-source.xml" },
          { kind: "step", ref: "S7" },
          { kind: "log", ref: "other.log" },
        ]),
        // No error recorded and no spec: those citations do not exist.
        hint("TC-02", [
          { kind: "error", ref: "error" },
          { kind: "spec", ref: "1" },
        ]),
        hint("TC-03", [{ kind: "error", ref: "error" }]),
        hint("TC-03", [{ kind: "error", ref: "error" }]),
        // Not a BLOCKED case.
        hint("TC-09", [{ kind: "log", ref: "appium.log" }]),
      ],
      evidence,
    );
    expect(out.hints.map((h) => [h.caseId, h.cites.map((c) => `${c.kind}:${c.ref}`)])).toEqual([
      [
        "TC-01",
        ["spec:3", "error:error", "step:S1", "evidence:TC-01/attempt-1/page-source.xml", "log:appium.log"],
      ],
      ["TC-03", ["error:error"]],
    ]);
    expect(out.dropped).toEqual(["TC-02", "TC-09"]);
  });
});
