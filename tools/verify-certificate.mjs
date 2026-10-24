#!/usr/bin/env node
// Reference verifier of QAJitsu test certificates (REQ-VER-21): Node.js built-ins only, no QAJitsu, no network.
// It follows docs/guides/certificates.md step by step, so a third party can read it next to the format description
// and write their own. Usage:
//   node verify-certificate.mjs <run folder> <public-key.pem> [<public-key.pem>...] [--tsa-ca <ca.pem>]...
// The run folder is a QAJitsu run or an unpacked `qj audit export` zip. Exit code 0 valid, 1 not valid, 2 usage.
import { X509Certificate, createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const tsaCaFiles = [];
for (let i = args.indexOf("--tsa-ca"); i >= 0; i = args.indexOf("--tsa-ca"))
  tsaCaFiles.push(...args.splice(i, 2).slice(1));
const [folder, ...keyFiles] = args;
if (!folder || keyFiles.length === 0) {
  process.stderr.write("Usage: node verify-certificate.mjs <run folder> <public-key.pem> [...]\n");
  process.exit(2);
}

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const problems = [];

// 1. The envelope (DSSE) and its signature over the pre-authentication encoding.
const envelope = JSON.parse(readFileSync(join(folder, "certificate", "certificate.dsse.json"), "utf8"));
const payload = Buffer.from(envelope.payload, "base64");
const pae = Buffer.concat([
  Buffer.from(
    `DSSEv1 ${Buffer.byteLength(envelope.payloadType)} ${envelope.payloadType} ${payload.byteLength} `,
  ),
  payload,
]);
const keys = keyFiles.map((f) => createPublicKey(readFileSync(f, "utf8")));
const keyId = (k) => sha256(k.export({ type: "spki", format: "der" })).toString("hex");
const signature = envelope.signatures?.[0];
const key = keys.find((k) => keyId(k) === signature?.keyid);
if (envelope.payloadType !== "application/vnd.in-toto+json") problems.push("unexpected payload type");
if (!signature) problems.push("not signed");
else if (!key) problems.push(`signed with key ${signature.keyid}, which is not one of the given keys`);
else if (!verify(null, pae, key, Buffer.from(signature.sig, "base64")))
  problems.push("signature does not match");

// 2. The statement (in-toto Statement v1 with the QAJitsu test-certificate predicate).
const statement = JSON.parse(payload.toString("utf8"));
if (statement._type !== "https://in-toto.io/Statement/v1") problems.push("not an in-toto statement");
if (statement.predicateType !== "https://qajitsu.dev/attestation/test-certificate/v1")
  problems.push("not a QAJitsu test certificate");

// 3. The Merkle root over the subjects (RFC 6962 shape).
const leaves = [...statement.subject]
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map((s) =>
    sha256(
      Uint8Array.of(0),
      s.name,
      Uint8Array.of(0),
      s.digest.sha256,
      Uint8Array.of(0),
      String(s.annotations.bytes),
    ),
  );
const tree = (nodes) => {
  if (nodes.length === 0) return sha256("");
  if (nodes.length === 1) return nodes[0];
  let k = 1;
  while (k * 2 < nodes.length) k *= 2;
  return sha256(Uint8Array.of(1), tree(nodes.slice(0, k)), tree(nodes.slice(k)));
};
if (tree(leaves).toString("hex") !== statement.predicate.merkleRoot)
  problems.push("Merkle root does not match");

// 4. Every covered file: exact files by size and digest, append-only files by their first `bytes` bytes.
// report/report.html is hashed with its certificate section emptied.
const SECTION = /<!--qajitsu:certificate-->([\s\S]*?)<!--\/qajitsu:certificate-->/;
for (const s of statement.subject) {
  // Names come from the certificate, which may be forged: never read outside the run folder.
  const parts = String(s.name).split("/");
  if (
    s.name === "" ||
    /^[A-Za-z]:|^\/|[\\\0]/.test(s.name) ||
    parts.some((p) => p === ".." || p === "." || p === "")
  ) {
    problems.push(`unsafe file name: ${JSON.stringify(s.name)}`);
    continue;
  }
  const path = join(folder, ...parts);
  if (!existsSync(path)) {
    problems.push(`missing: ${s.name}`);
    continue;
  }
  let data = readFileSync(path);
  if (s.name === "report/report.html")
    data = Buffer.from(
      data.toString("utf8").replace(SECTION, "<!--qajitsu:certificate--><!--/qajitsu:certificate-->"),
    );
  const prefix = s.annotations.prefix === true;
  const sizeOk = prefix ? data.byteLength >= s.annotations.bytes : data.byteLength === s.annotations.bytes;
  const part = prefix ? data.subarray(0, s.annotations.bytes) : data;
  if (!sizeOk || sha256(part).toString("hex") !== s.digest.sha256) problems.push(`changed: ${s.name}`);
}

// 5. Files the certificate would cover but does not list were added after it. Not covered by design: run.json, env/,
// audit/, certificate/, report/published/, report/media/, checked-out code under repos/<alias>/, and an export's
// SHA256SUMS and README.txt.
const listed = new Set(statement.subject.map((s) => s.name));
const excluded = (p) =>
  p === "run.json" ||
  p === "SHA256SUMS" ||
  p === "README.txt" ||
  /^(env|audit|certificate)\//.test(p) ||
  /^report\/(published|media)\//.test(p) ||
  /^repos\/[^/]+\//.test(p);
const walk = (dir, prefix) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) return walk(join(dir, e.name), rel);
    return e.isFile() ? [rel] : [];
  });
for (const p of walk(folder, ""))
  if (!listed.has(p) && !excluded(p)) problems.push(`added after the certificate: ${p}`);

// 6. The RFC 3161 timestamp, when there is one: certificate/timestamp.tsr stamps the SHA-256 of the payload.
// A minimal DER reader is enough: ContentInfo > SignedData > TSTInfo and the signer's signed attributes.
const notes = [];
const tokenPath = join(folder, "certificate", "timestamp.tsr");
if (existsSync(tokenPath)) {
  const parse = (buf, at = 0) => {
    const tag = buf[at];
    let len = buf[at + 1];
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4) throw new Error("bad length");
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
      head += n;
    }
    if (at + head + len > buf.length) throw new Error("truncated");
    const node = {
      tag,
      raw: buf.subarray(at, at + head + len),
      value: buf.subarray(at + head, at + head + len),
      kids: [],
    };
    if (tag & 0x20)
      for (let p = at + head; p < at + head + len; p += node.kids.at(-1).raw.length)
        node.kids.push(parse(buf, p));
    return node;
  };
  const oid = (n) => {
    if (!n || n.tag !== 6) return "";
    const out = [Math.floor(n.value[0] / 40), n.value[0] % 40];
    let v = 0;
    for (const b of n.value.subarray(1)) {
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) {
        out.push(v);
        v = 0;
      }
    }
    return out.join(".");
  };
  try {
    const token = parse(readFileSync(tokenPath));
    const sd = token.kids[1].kids[0].kids;
    const eContent = sd[2].kids[1].kids[0].value;
    const tst = parse(eContent);
    const stamped = tst.kids[2].kids[1].value;
    const time = tst.kids[4].value.toString("ascii");
    if (oid(tst.kids[2].kids[0].kids[0]) !== "2.16.840.1.101.3.4.2.1" || !stamped.equals(sha256(payload)))
      problems.push("timestamp: stamps another hash than this certificate's");
    const signer = sd.at(-1).kids[0].kids;
    const attrs = signer.find((k) => k.tag === 0xa0);
    const md = attrs.kids.find((a) => oid(a.kids[0]) === "1.2.840.113549.1.9.4").kids[1].kids[0].value;
    const hashOf = {
      "2.16.840.1.101.3.4.2.1": "sha256",
      "2.16.840.1.101.3.4.2.2": "sha384",
      "2.16.840.1.101.3.4.2.3": "sha512",
    };
    const digestAlg = hashOf[oid(signer[2].kids[0])];
    if (!digestAlg || !createHash(digestAlg).update(eContent).digest().equals(md))
      problems.push("timestamp: message digest does not match");
    const sigAlg = oid(signer[signer.indexOf(attrs) + 1].kids[0]);
    const signature = signer[signer.indexOf(attrs) + 2].value;
    const sigHash =
      sigAlg === "1.3.101.112"
        ? null
        : /^1\.2\.840\.113549\.1\.1\.1$/.test(sigAlg)
          ? digestAlg
          : {
              "1.2.840.113549.1.1.11": "sha256",
              "1.2.840.113549.1.1.12": "sha384",
              "1.2.840.113549.1.1.13": "sha512",
              "1.2.840.10045.4.3.2": "sha256",
              "1.2.840.10045.4.3.3": "sha384",
              "1.2.840.10045.4.3.4": "sha512",
            }[sigAlg];
    const signed = Buffer.concat([Buffer.from([0x31]), attrs.raw.subarray(1)]);
    const certs = (sd.find((k) => k.tag === 0xa0)?.kids ?? []).map((c) => new X509Certificate(c.raw));
    const cas = tsaCaFiles.map((f) => new X509Certificate(readFileSync(f)));
    const family = sigAlg === "1.3.101.112" ? "ed25519" : sigAlg.startsWith("1.2.840.10045.") ? "ec" : "rsa";
    const tsa = certs.find(
      (c) =>
        sigHash !== undefined &&
        c.publicKey.asymmetricKeyType === family &&
        verify(sigHash, signed, c.publicKey, signature),
    );
    if (!tsa) problems.push("timestamp: the TSA's signature does not verify");
    else {
      if (!(tsa.keyUsage ?? []).includes("1.3.6.1.5.5.7.3.8"))
        problems.push("timestamp: not a time-stamping certificate");
      // Trusted when the TSA certificate is, or chains to, a --tsa-ca certificate.
      let current = tsa;
      let trusted = false;
      for (let depth = 0; depth < 6 && !trusted; depth++) {
        if (cas.some((c) => c.fingerprint256 === current.fingerprint256)) trusted = true;
        else {
          const issuer = [...cas, ...certs].find(
            (c) =>
              c.fingerprint256 !== current.fingerprint256 &&
              current.checkIssued(c) &&
              current.verify(c.publicKey),
          );
          if (!issuer) break;
          current = issuer;
        }
      }
      // A timestamp proves the certificate existed by then: one claiming a later issue time is dated falsely.
      const g = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(time);
      const stampedAt = g ? Date.UTC(+g[1], +g[2] - 1, +g[3], +g[4], +g[5], +g[6]) : NaN;
      if (stampedAt + 5 * 60_000 < Date.parse(statement.predicate.issuedAt))
        problems.push("timestamp: the certificate claims to be issued after its timestamp");
      notes.push(
        `timestamped ${time} by ${tsa.subject.replace(/\n/g, ", ")}${trusted ? " (trusted TSA)" : " (TSA not trusted: pass --tsa-ca)"}`,
      );
    }
  } catch {
    problems.push("timestamp: certificate/timestamp.tsr is not a timestamp token");
  }
}

const id = `qjc-${sha256(payload).toString("hex").slice(0, 20)}`;
if (problems.length === 0) {
  process.stdout.write(
    `VALID ${id}: ${statement.predicate.ticket} run ${statement.predicate.runId}, ${statement.subject.length} files, root ${statement.predicate.merkleRoot}\n${notes.map((n) => `  ${n}\n`).join("")}`,
  );
  process.exit(0);
}
process.stdout.write(`NOT VALID ${id}:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
process.exit(1);
