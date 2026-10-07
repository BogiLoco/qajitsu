import { describe, expect, it } from "vitest";
import { canonicalJson, packCasesSha256 } from "./pack.js";

describe("regression pack hashes (REQ-EXEC-17/AC2)", () => {
  it("REQ-EXEC-17/AC2: the hash ignores key order and undefined members but sees every value", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }], u: undefined })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    );
    const cases = [{ id: "TC-01", steps: [{ id: "S1", expect: { fields: { total: 1.01 } } }] }];
    const reordered = [{ steps: [{ expect: { fields: { total: 1.01 } }, id: "S1" }], id: "TC-01" }];
    expect(packCasesSha256(reordered)).toBe(packCasesSha256(cases));
    const changed = [{ id: "TC-01", steps: [{ id: "S1", expect: { fields: { total: 1.02 } } }] }];
    expect(packCasesSha256(changed)).not.toBe(packCasesSha256(cases));
  });
});
