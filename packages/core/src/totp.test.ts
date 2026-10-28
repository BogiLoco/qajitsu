import { describe, expect, it } from "vitest";
import { totp } from "./totp.js";

// RFC 6238 appendix B: the seed "12345678901234567890" (SHA-1), as base32.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("time-based one-time codes (REQ-EXEC-55/AC1)", () => {
  it("REQ-EXEC-55/AC1: matches the RFC 6238 test vectors (SHA-1, 8 digits, 30 s)", () => {
    for (const [seconds, code] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ] as const)
      expect(totp(SEED, seconds * 1000, { digits: 8 })).toBe(code);
  });

  it("REQ-EXEC-55/AC1: six digits by default; spaces, lower case and padding in the seed are accepted; a bad seed is refused", () => {
    expect(totp(SEED, 59_000)).toBe("287082");
    expect(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====", 59_000)).toBe("287082");
    expect(() => totp("not base32!", 0)).toThrow("not a base32 TOTP seed");
    expect(() => totp("", 0)).toThrow("not a base32 TOTP seed");
  });
});
