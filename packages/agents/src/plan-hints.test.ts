import { describe, expect, it } from "vitest";
import { fillMissingEvidence, withPlacementHint } from "./plan-hints.js";

describe("placement hints for model repairs (REQ-LLM-04/AC2)", () => {
  it("names where a misplaced web field belongs; other errors stay as they are", () => {
    expect(
      withPlacementHint(
        ["cases", 2, "steps", 0, "expect", "elements", "geolocation"],
        "Invalid key in record",
      ),
    ).toBe(
      'Invalid key in record ("geolocation" belongs to the case: "browser": {"permissions": ["geolocation"], "geolocation": {"latitude": .., "longitude": ..}} next to "steps")',
    );
    expect(withPlacementHint(["cases", 0, "steps", 0, "expect"], 'Unrecognized key: "clock"')).toContain(
      '"clock" belongs to the case: "browser": {"clock": "<ISO time>"}',
    );
    expect(withPlacementHint(["cases", 0, "steps", 1], "Unrecognized keys: browser, files")).toContain(
      '"files" belongs to the case',
    );
    expect(withPlacementHint(["cases", 0, "title"], "Too small")).toBe("Too small");
    expect(
      withPlacementHint(
        ["cases", 1, "steps", 0, "expect", "elements", "offer-status"],
        "Invalid key in record",
      ),
    ).toContain('an element key is a selector with its kind: "testid:offer-status"');
    expect(
      withPlacementHint(["cases", 1, "steps", 0, "expect", "elements", "testid:x"], "Invalid key in record"),
    ).toBe("Invalid key in record");
    // Dogfood pass 2026-10-25: a selector as a state path, and a case without evidence.
    expect(
      withPlacementHint(
        ["cases", 0, "steps", 2, "expect", "state", "testid:address-1"],
        "Invalid key in record",
      ),
    ).toBe(
      'Invalid key in record ("testid:address-1" is an element: its check goes into "elements": {"testid:address-1": {"visible": ..}}; "state" holds paths of the application\'s test hook)',
    );
    expect(
      withPlacementHint(["cases", 3, "evidence"], "Too small: expected array to have >=1 items"),
    ).toContain('"evidence": ["screenshot"] for web and mobile');
  });

  it("REQ-LLM-04/AC2: evidence a case names nowhere is filled by code from its type; a named one is kept (dogfood 2026-10-28)", () => {
    const { value, filled } = fillMissingEvidence({
      summary: "s",
      cases: [
        { id: "TC-01", type: "web", evidence: [] },
        { id: "TC-02", type: "api" },
        { id: "TC-03", type: "mobile", evidence: ["video"] },
        { id: "TC-04", type: "unknown" },
      ],
    });
    expect(filled).toEqual(["TC-01", "TC-02"]);
    expect((value as { cases: { evidence?: string[] }[] }).cases.map((c) => c.evidence)).toEqual([
      ["screenshot"],
      ["request", "response"],
      ["video"],
      undefined,
    ]);
    expect(fillMissingEvidence("not a plan")).toEqual({ value: "not a plan", filled: [] });
  });
});
