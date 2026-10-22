#!/usr/bin/env node
// Reference verifier of QAJitsu test certificates (REQ-VER-21): Node.js built-ins only, no QAJitsu, no network.
// It follows docs/guides/certificates.md step by step, so a third party can read it next to the format description
// and write their own. Usage: node verify-certificate.mjs <run folder> <public-key.pem> [<public-key.pem>...]
// The run folder is a QAJitsu run or an unpacked `qj audit export` zip. Exit code 0 valid, 1 not valid, 2 usage.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [folder, ...keyFiles] = process.argv.slice(2);
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

const id = `qjc-${sha256(payload).toString("hex").slice(0, 20)}`;
if (problems.length === 0) {
  process.stdout.write(
    `VALID ${id}: ${statement.predicate.ticket} run ${statement.predicate.runId}, ${statement.subject.length} files, root ${statement.predicate.merkleRoot}\n`,
  );
  process.exit(0);
}
process.stdout.write(`NOT VALID ${id}:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
process.exit(1);
