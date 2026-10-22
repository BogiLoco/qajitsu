import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  CERTIFICATE_PREDICATE_TYPE,
  CertificateStatementSchema,
  DSSE_PAYLOAD_TYPE,
  STATEMENT_TYPE,
  renderCertificateBlock,
  splitCertificateBlock,
  type CertificateStatement,
  type CertificateSubject,
  type DsseEnvelope,
} from "@qajitsu/core";

/** Signs certificate payloads with one key. */
export interface CertificateSigner {
  readonly keyId: string;
  sign(data: Uint8Array): Uint8Array;
}

const hash = (...parts: (string | Uint8Array)[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/**
 * What the certificate does with a run-relative path: covers it exactly, covers the part written so far (journals
 * and logs only grow), or leaves it out. Left out: the run record (its parts that matter are copied into the
 * predicate), the env folder (secrets), the audit trail and the certificate themselves, and the copies made when
 * publishing (`report/published/`, `report/media/`).
 */
export function certificateScope(path: string): "exact" | "prefix" | "excluded" {
  if (
    path === "run.json" ||
    /^(env|audit|certificate)\//.test(path) ||
    path.startsWith("report/published/") ||
    path.startsWith("report/media/")
  )
    return "excluded";
  if (/^journal\/[^/]+\.jsonl$/.test(path) || /^logs\/.+\.log$/.test(path)) return "prefix";
  return "exact";
}

/**
 * The bytes the certificate hashes for a file: the file itself, except `report/report.html`, whose certificate section
 * is emptied (it is stamped after the certificate is issued, REQ-VER-15/AC7).
 */
export function certifiedContent(path: string, data: Uint8Array): Uint8Array {
  if (path !== "report/report.html") return data;
  return new TextEncoder().encode(splitCertificateBlock(new TextDecoder().decode(data)).covered);
}

/**
 * The subject of one file.
 *
 * @param path - Run-relative path (must not be excluded).
 * @param data - Its content.
 */
export function certificateSubject(path: string, data: Uint8Array): CertificateSubject {
  const content = certifiedContent(path, data);
  return {
    name: path,
    digest: { sha256: hash(content).toString("hex") },
    annotations: {
      bytes: content.byteLength,
      ...(certificateScope(path) === "prefix" ? { prefix: true } : {}),
    },
  };
}

/**
 * Merkle root over the subjects (REQ-VER-15/AC4), as in RFC 6962: leaves sorted by name, a leaf is
 * `SHA-256(0x00 ‖ name ‖ 0x00 ‖ sha256 hex ‖ 0x00 ‖ bytes)`, a node `SHA-256(0x01 ‖ left ‖ right)`, the left part the
 * largest power of two below the size. One changed byte in any file changes the root.
 *
 * @param subjects - The covered files.
 * @returns The root as hex; the hash of nothing for no subjects.
 */
export function merkleRoot(subjects: readonly CertificateSubject[]): string {
  const leaves = [...subjects]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) =>
      hash(
        Uint8Array.of(0),
        s.name,
        Uint8Array.of(0),
        s.digest.sha256,
        Uint8Array.of(0),
        String(s.annotations.bytes),
      ),
    );
  const tree = (nodes: readonly Buffer[]): Buffer => {
    if (nodes.length === 0) return hash("");
    if (nodes.length === 1) return nodes[0] ?? hash("");
    let k = 1;
    while (k * 2 < nodes.length) k *= 2;
    return hash(Uint8Array.of(1), tree(nodes.slice(0, k)), tree(nodes.slice(k)));
  };
  return tree(leaves).toString("hex");
}

/** DSSE pre-authentication encoding: what is signed. */
const pae = (payloadType: string, payload: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(payloadType))} ${payloadType} ${String(payload.byteLength)} `,
    ),
    payload,
  ]);

/** Id of a public key: SHA-256 of its SPKI DER encoding (REQ-VER-15/AC6). */
export function keyIdOf(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return hash(pub.export({ type: "spki", format: "der" })).toString("hex");
}

/**
 * A signer for an Ed25519 private key (REQ-VER-15/AC2+AC6). A KMS or HSM implements the same interface.
 *
 * @param key - The private key.
 */
export function keySigner(key: KeyObject): CertificateSigner {
  return { keyId: keyIdOf(key), sign: (data) => sign(null, data, key) };
}

/**
 * Builds the statement of a run's certificate (REQ-VER-15/AC1+AC4): every covered file as a subject, and the predicate
 * with the Merkle root over them.
 *
 * @param subjects - The covered files.
 * @param predicate - Run, plan, approvals, manifest, matrix, versions, images, environment, decision, time.
 */
export function certificateStatement(
  subjects: readonly CertificateSubject[],
  predicate: { readonly ticket: string; readonly runId: string; readonly issuedAt: string } & Readonly<
    Record<string, unknown>
  >,
): CertificateStatement {
  const sorted = [...subjects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    _type: STATEMENT_TYPE,
    subject: sorted,
    predicateType: CERTIFICATE_PREDICATE_TYPE,
    predicate: { ...predicate, files: sorted.length, merkleRoot: merkleRoot(sorted) },
  };
}

/**
 * Signs a statement into a DSSE envelope (REQ-VER-15/AC2+AC5).
 *
 * @param statement - The statement.
 * @param signer - The project key.
 */
export function signStatement(statement: CertificateStatement, signer: CertificateSigner): DsseEnvelope {
  const payload = Buffer.from(JSON.stringify(statement));
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [
      {
        keyid: signer.keyId,
        sig: Buffer.from(signer.sign(pae(DSSE_PAYLOAD_TYPE, payload))).toString("base64"),
      },
    ],
  };
}

/** Id of a certificate: `qjc-` and the first 20 hex digits of the SHA-256 of its payload. */
export function certificateId(envelope: DsseEnvelope): string {
  return `qjc-${hash(Buffer.from(envelope.payload, "base64")).toString("hex").slice(0, 20)}`;
}

/** The outcome of checking a certificate. */
export interface CertificateCheck {
  readonly id?: string;
  readonly keyId?: string;
  readonly statement?: CertificateStatement;
  /** Files whose content differs from the certificate. */
  readonly changed: readonly string[];
  /** Files the certificate covers that are gone. */
  readonly missing: readonly string[];
  /** Everything else that is wrong: signature, key, format, root. */
  readonly problems: readonly string[];
}

/**
 * Checks a certificate and the files it covers (REQ-VER-15/AC3): the signature with a trusted public key, the format,
 * the Merkle root over the subjects, and every file's digest and size (the written part of an append-only file). An
 * untrusted key, a broken signature or a changed byte anywhere fails the check.
 *
 * @param envelope - The parsed `certificate.dsse.json`.
 * @param trustedKeys - Public keys the checker trusts (current and rotated ones).
 * @param read - Reads a run-relative file; nothing when it is missing.
 */
export function checkCertificate(
  envelope: DsseEnvelope,
  trustedKeys: readonly KeyObject[],
  read: (path: string) => Uint8Array | undefined,
): CertificateCheck {
  const problems: string[] = [];
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE)
    return { changed: [], missing: [], problems: [`unexpected payload type ${envelope.payloadType}`] };
  const payload = Buffer.from(envelope.payload, "base64");
  const id = certificateId(envelope);
  const signature = envelope.signatures[0];
  const keys = new Map(trustedKeys.map((k) => [keyIdOf(k), k]));
  const key = signature ? keys.get(signature.keyid) : undefined;
  if (signature === undefined) problems.push("the certificate is not signed");
  else if (key === undefined)
    problems.push(
      `signed with key ${signature.keyid.slice(0, 16)}, which is not a trusted key (pass it with --key)`,
    );
  else if (!verify(null, pae(envelope.payloadType, payload), key, Buffer.from(signature.sig, "base64")))
    problems.push("the signature does not match: the certificate was changed or signed with another key");
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return { id, changed: [], missing: [], problems: [...problems, "the payload is not JSON"] };
  }
  const head = raw as { _type?: unknown; predicateType?: unknown } | null;
  if (head?._type !== STATEMENT_TYPE || head.predicateType !== CERTIFICATE_PREDICATE_TYPE)
    return { id, changed: [], missing: [], problems: [...problems, "not a QAJitsu test certificate"] };
  const parsed = CertificateStatementSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      id,
      changed: [],
      missing: [],
      problems: [
        ...problems,
        `the statement does not match the certificate schema: ${issue ? `${issue.path.join(".")}: ${issue.message}` : ""}`,
      ],
    };
  }
  const statement = parsed.data;
  if (merkleRoot(statement.subject) !== statement.predicate.merkleRoot)
    problems.push("the Merkle root does not match the listed files");
  const changed: string[] = [];
  const missing: string[] = [];
  for (const s of statement.subject) {
    const data = read(s.name);
    if (data === undefined) {
      missing.push(s.name);
      continue;
    }
    const content = certifiedContent(s.name, data);
    const part = s.annotations.prefix === true ? content.subarray(0, s.annotations.bytes) : content;
    const sizeOk =
      s.annotations.prefix === true
        ? content.byteLength >= s.annotations.bytes
        : content.byteLength === s.annotations.bytes;
    if (!sizeOk || hash(part).toString("hex") !== s.digest.sha256) changed.push(s.name);
    else if (s.name === "report/report.html") {
      // The certificate section is outside the hash, so only the exact stamp of this certificate may stand there.
      const { block } = splitCertificateBlock(new TextDecoder().decode(data));
      const allowed = [
        renderCertificateBlock(),
        ...(signature
          ? [
              renderCertificateBlock({
                id,
                merkleRoot: statement.predicate.merkleRoot,
                keyId: signature.keyid,
              }),
            ]
          : []),
      ];
      if (block !== undefined && !allowed.includes(block)) changed.push(s.name);
    }
  }
  return {
    id,
    ...(signature ? { keyId: signature.keyid } : {}),
    statement,
    changed,
    missing,
    problems,
  };
}
