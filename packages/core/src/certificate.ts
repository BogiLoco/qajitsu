import { z } from "zod";

/** Folder of a run that holds its certificate (REQ-VER-15); not part of what the certificate covers. */
export const CERTIFICATE_DIR = "certificate";

/** The signed certificate of a run: an in-toto statement in a DSSE envelope (REQ-VER-15/AC5). */
export const CERTIFICATE_FILE = "certificate/certificate.dsse.json";

/** in-toto statement type (REQ-VER-15/AC5). */
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
/** Predicate type of a QAJitsu test certificate; its schema is `schemas/test-certificate.v1.schema.json`. */
export const CERTIFICATE_PREDICATE_TYPE = "https://qajitsu.dev/attestation/test-certificate/v1";
/** DSSE payload type of an in-toto statement. */
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A file the certificate covers: its digest, size, and whether it may grow after the certificate. */
export const CertificateSubjectSchema = z.strictObject({
  /** Path relative to the run folder. */
  name: z.string().min(1),
  digest: z.strictObject({ sha256: Sha256Hex }),
  annotations: z.strictObject({
    /** Size of the covered content in bytes. */
    bytes: z.number().int().min(0),
    /** Append-only files (journals, logs) are covered up to `bytes`; later lines do not change what was certified. */
    prefix: z.literal(true).optional(),
  }),
});

/** A file the certificate covers. */
export type CertificateSubject = z.infer<typeof CertificateSubjectSchema>;

/**
 * The statement of a QAJitsu test certificate (REQ-VER-15/AC1+AC4+AC5): an in-toto Statement v1 whose subjects are
 * the run's files and whose predicate ties them to the run, its approved plan and approvals, the evidence manifest,
 * matrix and report, tool versions, image digests, the tested environment, the decision and the time, under one
 * Merkle root.
 */
export const CertificateStatementSchema = z.strictObject({
  _type: z.literal(STATEMENT_TYPE),
  subject: z.array(CertificateSubjectSchema),
  predicateType: z.literal(CERTIFICATE_PREDICATE_TYPE),
  predicate: z.looseObject({
    ticket: z.string(),
    runId: z.string(),
    issuedAt: z.string(),
    /** Number of subjects. */
    files: z.number().int().min(0),
    /** RFC 6962-style Merkle root over the subjects. */
    merkleRoot: Sha256Hex,
    repos: z.record(z.string(), z.unknown()).optional(),
    /** The approval of the frozen plan: version, SHA-256, approver, time. */
    plan: z.unknown().optional(),
    approvals: z.array(z.unknown()).optional(),
    planSha256: Sha256Hex.optional(),
    manifestSha256: Sha256Hex.optional(),
    matrixSha256: Sha256Hex.optional(),
    reportSha256: Sha256Hex.optional(),
    /** Status of each case, computed by code. */
    statuses: z.record(z.string(), z.string()).optional(),
    decision: z.string().optional(),
    versions: z.record(z.string(), z.string()).optional(),
    images: z.array(z.unknown()).optional(),
    environment: z.unknown().optional(),
    codeAccess: z.unknown().optional(),
  }),
});

/** The statement of a certificate. */
export type CertificateStatement = z.infer<typeof CertificateStatementSchema>;

/** A DSSE envelope (https://github.com/secure-systems-lab/dsse) holding a signed statement. */
export const DsseEnvelopeSchema = z.strictObject({
  payloadType: z.string(),
  /** The statement as base64 JSON. */
  payload: z.string(),
  signatures: z.array(z.strictObject({ keyid: z.string(), sig: z.string() })),
});

/** A DSSE envelope. */
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;

/** What a report shows about its certificate (REQ-VER-15/AC7). */
export interface CertificateSummary {
  readonly id: string;
  readonly merkleRoot: string;
  readonly keyId: string;
}

const OPEN = "<!--qajitsu:certificate-->";
const CLOSE = "<!--/qajitsu:certificate-->";
const BLOCK = /<!--qajitsu:certificate-->([\s\S]*?)<!--\/qajitsu:certificate-->/;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${String(c.charCodeAt(0))};`);

/**
 * The certificate section of `report.html` (REQ-VER-15/AC7): empty before the run is certified, then the certificate
 * id, the Merkle root and how to verify it. The certificate covers the report with this section emptied, so stamping
 * it does not change what was certified; a verifier accepts only exactly this rendering inside the markers.
 *
 * @param certificate - The certificate, or nothing for the empty section.
 */
export function renderCertificateBlock(certificate?: CertificateSummary): string {
  if (certificate === undefined) return `${OPEN}${CLOSE}`;
  return `${OPEN}<section class="certificate"><h2>Certificate</h2><p>Certificate <code>${esc(certificate.id)}</code> · Merkle root <code>${esc(certificate.merkleRoot)}</code> · signed with key <code>${esc(certificate.keyId.slice(0, 16))}</code></p><p class="muted">Verify the run folder or its audit export: <code>qj verify-report &lt;path&gt; --key &lt;public key&gt;</code>. Any changed file changes the root.</p></section>${CLOSE}`;
}

/**
 * Splits a report into the content the certificate covers (the certificate section emptied) and that section.
 *
 * @param html - Content of `report.html`.
 * @returns The covered content and the section's inner text, or nothing when the report has no section.
 */
export function splitCertificateBlock(html: string): { readonly covered: string; readonly block?: string } {
  const match = BLOCK.exec(html);
  if (match === null) return { covered: html };
  return { covered: html.replace(BLOCK, `${OPEN}${CLOSE}`), block: match[0] };
}
