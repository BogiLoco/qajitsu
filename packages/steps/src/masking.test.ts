import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_HEADERS, DEFAULT_SENSITIVE_KEYS, MASK, createMasker } from "./masking.js";

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

  // Found by mutation testing (REQ-NFR-14): every default name is masked, not only the first ones. The names are
  // written out: a list built from the constants under test would change along with a mutant.
  it.each(
    ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"].map((h) => [
      h,
    ]),
  )("REQ-CFG-06: the %s header is masked by default", (h) => {
    expect(createMasker().maskHeaders({ [h.toUpperCase()]: "value-1", accept: "text/html" })).toEqual({
      [h.toUpperCase()]: MASK,
      accept: "text/html",
    });
  });

  it.each(
    [
      "password",
      "passwd",
      "secret",
      "token",
      "access_token",
      "refresh_token",
      "api_key",
      "apikey",
      "client_secret",
    ].map((k) => [k]),
  )("REQ-CFG-06: the %s key is masked by default", (k) => {
    expect(createMasker().maskJson({ [k.toUpperCase()]: "value-1", name: "Ada" })).toEqual({
      [k.toUpperCase()]: MASK,
      name: "Ada",
    });
  });

  it("REQ-CFG-06: the default names are lowercase, as the case-insensitive lookup needs", () => {
    for (const name of [...DEFAULT_SENSITIVE_HEADERS, ...DEFAULT_SENSITIVE_KEYS])
      expect(name).toBe(name.toLowerCase());
  });
});
