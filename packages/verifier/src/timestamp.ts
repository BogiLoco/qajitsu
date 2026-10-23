import { X509Certificate, createHash, verify as verifySignature } from "node:crypto";

/**
 * RFC 3161 trusted timestamps (REQ-VER-17): the request QAJitsu sends to a time-stamping authority (only a hash), and
 * the offline check of the token it returns. Node.js built-ins only: a minimal DER reader and writer, CMS SignedData
 * (RFC 5652) and TSTInfo (RFC 3161 §2.4.2).
 */

/** A parsed DER element. */
export interface DerNode {
  readonly tag: number;
  /** The whole element, header included (for re-encoding and hashing). */
  readonly raw: Buffer;
  /** The content octets. */
  readonly value: Buffer;
  readonly children: readonly DerNode[];
}

const CONSTRUCTED = 0x20;

/** Parses one DER element at `offset`; throws on malformed or truncated input. */
export function derParse(buf: Buffer, offset = 0, depth = 0): DerNode {
  if (depth > 40) throw new Error("DER nested too deeply");
  if (offset + 2 > buf.length) throw new Error("DER truncated");
  const tag = buf[offset] ?? 0;
  if ((tag & 0x1f) === 0x1f) throw new Error("DER high tag numbers are not supported");
  let len = buf[offset + 1] ?? 0;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER length not supported");
    if (offset + 2 + n > buf.length) throw new Error("DER truncated");
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + (buf[offset + 2 + i] ?? 0);
    header += n;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new Error("DER truncated");
  const value = buf.subarray(offset + header, end);
  const children: DerNode[] = [];
  if (tag & CONSTRUCTED) {
    let at = offset + header;
    while (at < end) {
      const child = derParse(buf, at, depth + 1);
      children.push(child);
      at += child.raw.length;
    }
  }
  return { tag, raw: buf.subarray(offset, end), value, children };
}

const encodeLength = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

/** DER encoders, enough for timestamp requests and for building test certificates and tokens. */
export const der = {
  node: (tag: number, content: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]),
  seq: (...items: Buffer[]): Buffer => der.node(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]): Buffer => der.node(0x31, Buffer.concat(items)),
  int: (value: Buffer | number): Buffer => {
    const hex = typeof value === "number" ? value.toString(16) : "";
    let b = typeof value === "number" ? Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex") : value;
    while (b.length > 1 && b[0] === 0 && ((b[1] ?? 0) & 0x80) === 0) b = b.subarray(1);
    if (((b[0] ?? 0) & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
    return der.node(0x02, b);
  },
  oid: (dotted: string): Buffer => {
    const parts = dotted.split(".").map(Number);
    const out = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
    for (const p of parts.slice(2)) {
      const chunk = [p & 0x7f];
      for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
      out.push(...chunk);
    }
    return der.node(0x06, Buffer.from(out));
  },
  octets: (b: Buffer): Buffer => der.node(0x04, b),
  bool: (v: boolean): Buffer => der.node(0x01, Buffer.from([v ? 0xff : 0])),
  null: (): Buffer => Buffer.from([0x05, 0x00]),
  /** Context-specific tag `[n]`, constructed (explicit or a constructed implicit type). */
  ctx: (n: number, content: Buffer): Buffer => der.node(0xa0 | n, content),
};

const oidOf = (node: DerNode | undefined): string => {
  if (node?.tag !== 0x06) return "";
  const b = node.value;
  const first = b[0] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (const byte of b.subarray(1)) {
    v = v * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
};

/** OIDs used here. */
export const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  timeStamping: "1.3.6.1.5.5.7.3.8",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha384WithRSA: "1.2.840.113549.1.1.12",
  sha512WithRSA: "1.2.840.113549.1.1.13",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  ed25519: "1.3.101.112",
} as const;

const HASHES: Readonly<Record<string, string>> = {
  [OID.sha256]: "sha256",
  [OID.sha384]: "sha384",
  [OID.sha512]: "sha512",
};
const SIGNATURES: Readonly<Record<string, string | null>> = {
  [OID.sha256WithRSA]: "sha256",
  [OID.sha384WithRSA]: "sha384",
  [OID.sha512WithRSA]: "sha512",
  [OID.ecdsaSha256]: "sha256",
  [OID.ecdsaSha384]: "sha384",
  [OID.ecdsaSha512]: "sha512",
  [OID.ed25519]: null,
};

/**
 * An RFC 3161 TimeStampReq for a SHA-256 digest (REQ-VER-17/AC4: only the hash leaves the machine), asking for the
 * TSA's certificate in the token.
 *
 * @param digest - SHA-256 of what is timestamped (32 bytes).
 * @param nonce - Random bytes the token must repeat.
 */
export function timestampRequest(digest: Buffer, nonce: Buffer): Buffer {
  if (digest.length !== 32) throw new Error("a SHA-256 digest has 32 bytes");
  return der.seq(
    der.int(1),
    der.seq(der.seq(der.oid(OID.sha256), der.null()), der.octets(digest)),
    der.int(nonce),
    der.bool(true),
  );
}

/** The status and token of a TimeStampResp. */
export interface TimestampResponse {
  /** PKIStatus: 0 granted, 1 granted with modifications, 2 rejection, 3 waiting, 4/5 revocation. */
  readonly status: number;
  readonly statusText?: string;
  /** The TimeStampToken (a CMS ContentInfo), when granted. */
  readonly token?: Buffer;
}

/** Parses a TimeStampResp (`application/timestamp-reply`). */
export function parseTimestampResponse(body: Buffer): TimestampResponse {
  const resp = derParse(body);
  const statusInfo = resp.children[0];
  const status =
    statusInfo?.children[0]?.value.readUIntBE(0, Math.min(statusInfo.children[0].value.length, 4)) ?? -1;
  const texts = statusInfo?.children[1]?.children.map((c) => c.value.toString("utf8")) ?? [];
  const token = resp.children[1]?.raw;
  return {
    status,
    ...(texts.length > 0 ? { statusText: texts.join("; ") } : {}),
    ...(token && status <= 1 ? { token: Buffer.from(token) } : {}),
  };
}

/** What an offline check of a timestamp token found. */
export interface TimestampCheck {
  /** The token is well formed, signed by the certificate in it, and stamps the expected digest. */
  readonly ok: boolean;
  /** The signing certificate chains to one of the trusted TSA certificates. */
  readonly trusted: boolean;
  readonly problems: readonly string[];
  /** The time the TSA vouches for (ISO). */
  readonly genTime?: string;
  readonly serial?: string;
  /** Subject of the TSA certificate. */
  readonly tsa?: string;
}

const parseGeneralizedTime = (node: DerNode | undefined): Date | undefined => {
  if (node?.tag !== 0x18) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d{1,9}))?Z$/.exec(
    node.value.toString("ascii"),
  );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac] = m;
  return new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number((frac ?? "0").slice(0, 3).padEnd(3, "0")),
    ),
  );
};

/** Walks from the signing certificate to a trusted one through the token's certificates. */
function chainsTo(
  cert: X509Certificate,
  pool: readonly X509Certificate[],
  trusted: readonly X509Certificate[],
  at: Date,
): boolean {
  let current = cert;
  for (let depth = 0; depth < 6; depth += 1) {
    if (trusted.some((t) => t.fingerprint256 === current.fingerprint256)) return true;
    const issuer = [...trusted, ...pool].find(
      (c) =>
        c.fingerprint256 !== current.fingerprint256 && current.checkIssued(c) && current.verify(c.publicKey),
    );
    if (!issuer) return false;
    if (at < new Date(issuer.validFrom) || at > new Date(issuer.validTo)) return false;
    if (trusted.some((t) => t.fingerprint256 === issuer.fingerprint256)) return true;
    current = issuer;
  }
  return false;
}

/**
 * Checks an RFC 3161 timestamp token offline (REQ-VER-17/AC3): the CMS structure, the message digest and content type
 * of the signed attributes, the TSA's signature with the certificate carried in the token, its `timeStamping` key
 * purpose and validity at the stamped time, that the token stamps `digest`, and (with `nonce`) that it answers this
 * request. `trusted` are the TSA CA certificates the project trusts; without a chain to one of them the token is
 * consistent but not trusted.
 */
export function checkTimestampToken(
  token: Buffer,
  digest: Buffer,
  options: { readonly trusted?: readonly X509Certificate[]; readonly nonce?: Buffer } = {},
): TimestampCheck {
  const problems: string[] = [];
  const fail = (p: string): TimestampCheck => ({ ok: false, trusted: false, problems: [...problems, p] });
  let content: DerNode;
  try {
    content = derParse(token);
  } catch (error) {
    return fail(`not a timestamp token: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (oidOf(content.children[0]) !== OID.signedData) return fail("not CMS SignedData");
  const signedData = content.children[1]?.children[0];
  const kids = signedData?.children ?? [];
  const encap = kids[2];
  if (oidOf(encap?.children[0]) !== OID.tstInfo) return fail("the token does not carry a TSTInfo");
  const eContent = encap?.children[1]?.children[0]?.value;
  if (!eContent) return fail("the token has no content");
  const certNode = kids.find((k) => k.tag === 0xa0);
  const signerInfos = kids.at(-1);
  const signer = signerInfos?.tag === 0x31 ? signerInfos.children[0] : undefined;
  if (!signer) return fail("the token has no signer");

  // TSTInfo: what was stamped and when.
  let tst: DerNode;
  try {
    tst = derParse(Buffer.from(eContent));
  } catch {
    return fail("TSTInfo is malformed");
  }
  const imprint = tst.children[2];
  const hashAlg = HASHES[oidOf(imprint?.children[0]?.children[0])];
  const hashed = imprint?.children[1]?.value;
  if (hashAlg !== "sha256" || !hashed || !Buffer.from(hashed).equals(digest))
    problems.push("the token stamps another hash than this certificate's");
  const serial = tst.children[3]?.value.toString("hex");
  const genTime = parseGeneralizedTime(tst.children[4]);
  if (!genTime) return fail("the token has no valid time");
  if (options.nonce) {
    const nonce = tst.children.slice(5).find((c) => c.tag === 0x02);
    const n = (b: Buffer) => b.toString("hex").replace(/^(00)+/, "");
    if (!nonce || n(Buffer.from(nonce.value)) !== n(options.nonce))
      problems.push("the token does not answer this request (nonce)");
  }

  // Signed attributes: content type and message digest over the TSTInfo.
  const sc = signer.children;
  const digestAlg = HASHES[oidOf(sc[2]?.children[0])];
  const attrs = sc.find((c) => c.tag === 0xa0);
  if (!digestAlg || !attrs) return fail("the signer has no supported digest or no signed attributes");
  const attr = (oid: string) =>
    attrs.children.find((a) => oidOf(a.children[0]) === oid)?.children[1]?.children[0];
  if (oidOf(attr(OID.contentType)) !== OID.tstInfo) problems.push("signed content type is not TSTInfo");
  const md = attr(OID.messageDigest)?.value;
  if (!md || !createHash(digestAlg).update(eContent).digest().equals(md))
    problems.push("message digest does not match the TSTInfo");
  const sigAlgOid = oidOf(sc[sc.indexOf(attrs) + 1]?.children[0]);
  const signature = sc[sc.indexOf(attrs) + 2]?.value;
  const sigHash = sigAlgOid === OID.rsaEncryption ? digestAlg : SIGNATURES[sigAlgOid];
  if (sigHash === undefined || !signature) return fail(`unsupported signature algorithm ${sigAlgOid}`);
  // The signature covers the signed attributes encoded as a SET (RFC 5652 §5.4).
  const signedBytes = Buffer.concat([Buffer.from([0x31]), attrs.raw.subarray(1)]);

  const certs: X509Certificate[] = [];
  for (const c of certNode?.children ?? [])
    try {
      certs.push(new X509Certificate(c.raw));
    } catch {
      // Not a certificate (attribute certificates and others are ignored).
    }
  // The key must be of the family the token names: a mislabelled signature is refused, not reinterpreted.
  const family =
    sigAlgOid === OID.ed25519 ? "ed25519" : sigAlgOid.startsWith("1.2.840.10045.") ? "ec" : "rsa";
  const tsaCert = [...certs, ...(options.trusted ?? [])].find((c) => {
    if (c.publicKey.asymmetricKeyType !== family) return false;
    try {
      return verifySignature(sigHash, signedBytes, c.publicKey, Buffer.from(signature));
    } catch {
      return false;
    }
  });
  if (!tsaCert) return fail("the TSA's signature does not verify with any certificate in the token");
  // Node gives no extended key usage as undefined, whatever its types say.
  const purposes: unknown = tsaCert.keyUsage;
  if (!Array.isArray(purposes) || !purposes.includes(OID.timeStamping))
    problems.push("the signing certificate is not for time stamping");
  if (genTime < new Date(tsaCert.validFrom) || genTime > new Date(tsaCert.validTo))
    problems.push("the signing certificate was not valid at the stamped time");
  const trusted = chainsTo(tsaCert, certs, options.trusted ?? [], genTime);
  return {
    ok: problems.length === 0,
    trusted: problems.length === 0 && trusted,
    problems,
    genTime: genTime.toISOString(),
    ...(serial === undefined ? {} : { serial }),
    tsa: tsaCert.subject.replace(/\n/g, ", "),
  };
}
