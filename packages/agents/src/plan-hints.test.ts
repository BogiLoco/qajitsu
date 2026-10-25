import { describe, expect, it } from "vitest";
import { withPlacementHint } from "./plan-hints.js";

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
  });
});
