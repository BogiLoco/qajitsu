import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeTsa } from "../../../tests/support/fake-tsa.js";
import {
  OID,
  checkTimestampToken,
  der,
  derParse,
  parseTimestampResponse,
  timestampRequest,
} from "./timestamp.js";

const digest = createHash("sha256").update("statement").digest();
const nonce = Buffer.from("0102030405060708", "hex");

const stamped = (o: Parameters<ReturnType<typeof createFakeTsa>["stamp"]>[1] = {}) => {
  const tsa = createFakeTsa();
  const response = parseTimestampResponse(tsa.stamp(timestampRequest(digest, nonce), o));
  return { tsa, response, trusted: [new X509Certificate(tsa.caPem)] };
};

describe("RFC 3161 timestamps (REQ-VER-17)", () => {
  it("REQ-VER-17/AC4: the request carries only the SHA-256 digest and a nonce", () => {
    const req = timestampRequest(digest, nonce);
    const node = derParse(req);
    expect(node.children).toHaveLength(4);
    expect(Buffer.from(node.children[1]?.children[1]?.value ?? []).equals(digest)).toBe(true);
    expect(req.length).toBeLessThan(80);
    expect(() => timestampRequest(Buffer.alloc(20), nonce)).toThrow("32 bytes");
  });

  it("REQ-VER-17/AC3: a token of a trusted TSA for this digest is valid and trusted, with its time", () => {
    const { response, trusted } = stamped();
    expect(response.status).toBe(0);
    const check = checkTimestampToken(response.token ?? Buffer.alloc(0), digest, { trusted, nonce });
    expect(check).toMatchObject({
      ok: true,
      trusted: true,
      problems: [],
      genTime: "2026-10-03T10:46:00.000Z",
    });
    expect(check.tsa).toContain("Fake TSA");
  });

  it("REQ-VER-17/AC3: without the TSA's CA the token is consistent but not trusted", () => {
    const { response } = stamped();
    const other = [new X509Certificate(createFakeTsa().caPem)];
    expect(checkTimestampToken(response.token ?? Buffer.alloc(0), digest)).toMatchObject({
      ok: true,
      trusted: false,
    });
    expect(checkTimestampToken(response.token ?? Buffer.alloc(0), digest, { trusted: other })).toMatchObject({
      ok: true,
      trusted: false,
    });
  });

  it("REQ-VER-17/AC3: a token for another hash, tampered, signed by another key, without the time-stamping purpose or for another request is refused", () => {
    const token = (o: Parameters<typeof stamped>[0]) => {
      const s = stamped(o);
      return checkTimestampToken(s.response.token ?? Buffer.alloc(0), digest, { trusted: s.trusted, nonce });
    };
    expect(token({ digest: randomBytes(32) }).problems).toContain(
      "the token stamps another hash than this certificate's",
    );
    expect(token({ tamper: true }).problems).toContain("message digest does not match the TSTInfo");
    expect(token({ wrongKey: true }).problems).toEqual([
      "the TSA's signature does not verify with any certificate in the token",
    ]);
    expect(token({ noEku: true }).problems).toContain("the signing certificate is not for time stamping");
    expect(token({ nonce: Buffer.from("ff", "hex") }).problems).toContain(
      "the token does not answer this request (nonce)",
    );
    expect(token({ genTime: new Date("2031-01-01T00:00:00Z") }).problems).toContain(
      "the signing certificate was not valid at the stamped time",
    );
    for (const o of [{ digest: randomBytes(32) }, { tamper: true }, { noEku: true }])
      expect(token(o)).toMatchObject({ ok: false, trusted: false });
  });

  it("REQ-VER-17/AC5: a rejected request has no token; garbage is not a token", () => {
    expect(stamped({ status: 2 }).response).toEqual({ status: 2, statusText: "request rejected" });
    expect(checkTimestampToken(Buffer.from("not der at all"), digest).ok).toBe(false);
    expect(
      checkTimestampToken(Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]), digest).problems[0],
    ).toContain("not a timestamp token");
    expect(checkTimestampToken(Buffer.from([0x30, 0x00]), digest).problems).toEqual(["not CMS SignedData"]);
  });

  it("REQ-VER-17/AC3: trust follows the chain through an intermediate valid at the stamped time, or the TSA certificate itself", () => {
    const tsa = createFakeTsa();
    const ca = [new X509Certificate(tsa.caPem)];
    const token = (o: Parameters<typeof tsa.stamp>[1]) =>
      parseTimestampResponse(tsa.stamp(timestampRequest(digest, nonce), o)).token ?? Buffer.alloc(0);
    expect(checkTimestampToken(token({ intermediate: "valid" }), digest, { trusted: ca })).toMatchObject({
      ok: true,
      trusted: true,
    });
    expect(checkTimestampToken(token({ intermediate: "expired" }), digest, { trusted: ca })).toMatchObject({
      ok: true,
      trusted: false,
    });
    expect(
      checkTimestampToken(token({}), digest, { trusted: [new X509Certificate(tsa.tsaPem)] }),
    ).toMatchObject({ ok: true, trusted: true });
    // A token without certificates verifies with a trusted TSA certificate given by the checker.
    expect(
      checkTimestampToken(token({ noCerts: true }), digest, { trusted: [new X509Certificate(tsa.tsaPem)] }),
    ).toMatchObject({ ok: true, trusted: true });
    expect(checkTimestampToken(token({ noCerts: true }), digest).problems).toEqual([
      "the TSA's signature does not verify with any certificate in the token",
    ]);
    expect(checkTimestampToken(token({ junkCert: true }), digest, { trusted: ca }).ok).toBe(true);
  });

  it("REQ-VER-17/AC3: every part of a token that is missing or unsupported is named", () => {
    const tsa = createFakeTsa();
    const problems = (o: Parameters<typeof tsa.stamp>[1]) =>
      checkTimestampToken(
        parseTimestampResponse(tsa.stamp(timestampRequest(digest, nonce), o)).token ?? Buffer.alloc(0),
        digest,
        { nonce },
      ).problems;
    expect(problems({ noSigner: true })).toEqual(["the token has no signer"]);
    expect(problems({ junkTst: true })).toEqual(["TSTInfo is malformed"]);
    expect(problems({ rawTime: "yesterday" })).toEqual(["the token has no valid time"]);
    expect(problems({ noNonce: true })).toContain("the token does not answer this request (nonce)");
    expect(problems({ imprintAlg: OID.sha384 })).toContain(
      "the token stamps another hash than this certificate's",
    );
    expect(problems({ contentType: OID.signedData })).toContain("signed content type is not TSTInfo");
    expect(problems({ noAttrs: true })).toEqual([
      "the signer has no supported digest or no signed attributes",
    ]);
    expect(problems({ digestAlg: "1.2.3.4" })).toEqual([
      "the signer has no supported digest or no signed attributes",
    ]);
    expect(problems({ sigAlg: "1.2.3.4" })).toEqual(["unsupported signature algorithm 1.2.3.4"]);
    // Named Ed25519 while the key is ECDSA: the signature check fails without throwing.
    expect(problems({ sigAlg: OID.ed25519 })).toEqual([
      "the TSA's signature does not verify with any certificate in the token",
    ]);
    expect(problems({ digestAlg: OID.sha512 })).toContain("message digest does not match the TSTInfo");
    // A time with fractions of a second is read.
    expect(
      checkTimestampToken(
        parseTimestampResponse(tsa.stamp(timestampRequest(digest, nonce), { rawTime: "20261003104600.25Z" }))
          .token ?? Buffer.alloc(0),
        digest,
      ).genTime,
    ).toBe("2026-10-03T10:46:00.250Z");
  });

  it("REQ-VER-17/AC3: malformed DER is refused, never read past its end", () => {
    expect(() => derParse(Buffer.from([0x30]))).toThrow("DER truncated");
    expect(() => derParse(Buffer.from([0x1f, 0x00]))).toThrow("high tag numbers");
    expect(() => derParse(Buffer.from([0x30, 0x80]))).toThrow("length not supported");
    expect(() => derParse(Buffer.from([0x30, 0x85, 1, 2, 3, 4, 5]))).toThrow("length not supported");
    expect(() => derParse(Buffer.from([0x30, 0x82, 0x01]))).toThrow("DER truncated");
    expect(() => derParse(Buffer.from([0x04, 0x05, 0x01]))).toThrow("DER truncated");
    let nested: Buffer = Buffer.from([0x05, 0x00]);
    for (let i = 0; i < 45; i += 1) nested = der.seq(nested);
    expect(() => derParse(nested)).toThrow("nested too deeply");
    // Long lengths and integers are encoded minimally, positive.
    expect(derParse(der.octets(Buffer.alloc(300))).value).toHaveLength(300);
    expect(der.int(Buffer.from([0x00, 0x00, 0x7f]))).toEqual(Buffer.from([0x02, 0x01, 0x7f]));
    expect(der.int(Buffer.from([0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
    expect(der.int(0x123)).toEqual(Buffer.from([0x02, 0x02, 0x01, 0x23]));
    expect(parseTimestampResponse(der.seq(der.seq(der.int(1)))).status).toBe(1);
  });

  it("REQ-VER-17/AC3: a token with parts of its structure missing is refused with the part named", () => {
    const signedData = (...kids: Buffer[]) => der.seq(der.oid(OID.signedData), der.ctx(0, der.seq(...kids)));
    const check = (b: Buffer) => checkTimestampToken(b, digest).problems;
    expect(check(der.seq(der.oid(OID.signedData)))).toEqual(["the token does not carry a TSTInfo"]);
    expect(check(signedData(der.int(3), der.set(), der.seq(der.oid(OID.tstInfo))))).toEqual([
      "the token has no content",
    ]);
    const tst = (inner: Buffer) =>
      signedData(
        der.int(3),
        der.set(),
        der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octets(inner))),
        der.set(der.seq(der.int(1))),
      );
    // A TSTInfo with nothing but its version: no imprint, no time.
    expect(check(tst(der.seq(der.int(1))))).toEqual([
      "the token stamps another hash than this certificate's",
      "the token has no valid time",
    ]);
    // Signed attributes without content type and message digest, and no signature.
    const time = der.node(0x18, Buffer.from("20261003104600Z"));
    const info = der.seq(
      der.int(1),
      der.oid("1.2.3"),
      der.seq(der.seq(der.oid(OID.sha256)), der.octets(digest)),
      der.int(5),
      time,
    );
    const bare = signedData(
      der.int(3),
      der.set(),
      der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octets(info))),
      der.set(
        der.seq(
          der.int(1),
          der.seq(),
          der.seq(der.oid(OID.sha256)),
          der.ctx(0, der.seq(der.oid("1.2.3"), der.set())),
        ),
      ),
    );
    expect(check(bare)).toEqual([
      "signed content type is not TSTInfo",
      "message digest does not match the TSTInfo",
      "unsupported signature algorithm ",
    ]);
    expect(parseTimestampResponse(der.seq()).status).toBe(-1);
  });
});
