import { describe, expect, it } from "vitest";
import { MASK, createMasker } from "./masking.js";

// Fake values only; real credentials never appear in this repository.
const token = ["fake", "token", "0123456789"].join("-");

describe("createMasker (REQ-CFG-06)", () => {
  it("masks registered secrets in text, including repeated and overlapping values", () => {
    const masker = createMasker({ secrets: [token, `${token}-long`] });
    expect(masker.maskText(`a ${token}-long b ${token} c ${token}`)).toBe(`a ${MASK} b ${MASK} c ${MASK}`);
  });

  it("escapes regular expression characters in secrets", () => {
    const masker = createMasker({ secrets: ["p@ss.w*rd(1)"] });
    expect(masker.maskText("x p@ss.w*rd(1) y pXssXwXrd(1)")).toBe(`x ${MASK} y pXssXwXrd(1)`);
  });

  it("ignores very short secrets to avoid masking ordinary words", () => {
    const masker = createMasker({ secrets: ["abc"] });
    expect(masker.maskText("abc")).toBe("abc");
  });

  it("returns text unchanged when nothing is registered", () => {
    expect(createMasker().maskText("hello")).toBe("hello");
  });

  it("masks sensitive headers by name, case-insensitively, and secrets in other headers", () => {
    const masker = createMasker({ secrets: [token], sensitiveHeaders: ["X-Tenant-Key"] });
    expect(
      masker.maskHeaders({
        Authorization: "Bearer whatever",
        "X-Tenant-Key": "t",
        "X-Debug": `id=${token}`,
        Accept: "application/json",
      }),
    ).toEqual({
      Authorization: MASK,
      "X-Tenant-Key": MASK,
      "X-Debug": `id=${MASK}`,
      Accept: "application/json",
    });
  });

  it("masks sensitive JSON keys and secret values at any depth", () => {
    const masker = createMasker({ secrets: [token], sensitiveKeys: ["pin"] });
    const body = {
      user: { password: "hunter22", Token: "x", pin: 1234, name: "Ann" },
      items: [{ note: `uses ${token}` }, 7, null, true],
    };
    expect(masker.maskJson(body)).toEqual({
      user: { password: MASK, Token: MASK, pin: MASK, name: "Ann" },
      items: [{ note: `uses ${MASK}` }, 7, null, true],
    });
  });

  it("registers secrets resolved later and detects leftovers", () => {
    const masker = createMasker();
    expect(masker.containsSecret(`x ${token}`)).toBe(false);
    masker.register(token);
    masker.register(token);
    expect(masker.containsSecret(`x ${token}`)).toBe(true);
    expect(masker.containsSecret(`x ${token}`)).toBe(true);
    expect(masker.containsSecret("clean")).toBe(false);
  });
});
