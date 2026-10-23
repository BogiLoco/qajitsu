import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CERTIFICATE_DIR,
  CERTIFICATE_FILE,
  ConfigError,
  GateFailedError,
  QajitsuError,
  renderCertificateBlock,
  splitCertificateBlock,
  type CertificateSubject,
  type CertificateSummary,
  type DsseEnvelope,
} from "@qajitsu/core";
import { unzip } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import {
  certificateId,
  certificateScope,
  certificateStatement,
  certificateSubject,
  certificateCoverage,
  checkCertificate,
  checkTimestampToken,
  keyIdOf,
  keySigner,
  signStatement,
  type CertificateCheck,
  formatDecision,
} from "@qajitsu/verifier";
import type { RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import { loadAuditTrail } from "./audit-trail.js";
import type { CommandIO } from "./fetch.js";
import { TIMESTAMP_TOKEN, payloadDigest, stampCertificate, trustedTsaCertificates } from "./timestamp.js";
import { archiveRun, plannedStorage } from "./archive.js";
import { computeVerdict, writeReports } from "./verdict.js";

/** Folder of the project's trusted public keys (REQ-VER-15/AC6). */
export const KEYS_DIR = "keys";

/** Reads every `*.pub` file of a folder as a public key with where it came from; unreadable files are skipped. */
export async function publicKeysIn(dir: string): Promise<{ key: KeyObject; source: string }[]> {
  const keys: { key: KeyObject; source: string }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (name.endsWith(".pub"))
      try {
        keys.push({
          key: createPublicKey(await readFile(join(dir, name), "utf8")),
          source: `.qa/keys/${name}`,
        });
      } catch {
        // Not a key: ignored, the check names the key it needs.
      }
  return keys;
}

/** The project's signing key from the secret provider: PEM, or the PEM in base64 (for environment variables). */
async function signingKey(session: RunSession): Promise<KeyObject | undefined> {
  const ref = session.project.config.certificate.signing_key;
  if (ref === undefined) return undefined;
  const value = (await session.resolveSecret(ref)).trim();
  const pem = value.startsWith("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new ConfigError(
      "CERTIFICATE_KEY_INVALID",
      `certificate.signing_key (${ref}) is not a private key in PEM or base64 PEM; create one with qj audit keygen.`,
      {},
    );
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new ConfigError(
      "CERTIFICATE_KEY_INVALID",
      `certificate.signing_key must be an Ed25519 key, not ${String(key.asymmetricKeyType)}.`,
      {},
    );
  return key;
}

/** What the certificate states about the outcome, computed from the run's files. */
export interface CertifiedVerdict {
  readonly decision: string;
  readonly statuses: Readonly<Record<string, string>>;
}

/** The certified outcome of a computed verdict. */
export function certifiedVerdict(verdict: {
  readonly decision: Parameters<typeof formatDecision>[0];
  readonly cases: readonly { readonly caseId: string; readonly status: string }[];
}): CertifiedVerdict {
  return {
    decision: formatDecision(verdict.decision),
    statuses: Object.fromEntries(verdict.cases.map((c) => [c.caseId, c.status])),
  };
}

/** The outcome of issuing a certificate. */
export type IssueOutcome =
  | { readonly status: "off" }
  | { readonly status: "gaps"; readonly gaps: readonly string[] }
  | {
      readonly status: "issued";
      readonly certificate: CertificateSummary;
      readonly reused: boolean;
      /** The timestamp line (REQ-VER-17), when a TSA is configured. */
      readonly timestamp?: string;
      /** The write-once storage line (REQ-VER-19), when an archive is configured. */
      readonly archived?: string;
    };

const readRunFile = (dir: string) => async (path: string) =>
  new Uint8Array(await readFile(join(dir, path))).slice();

/**
 * Issues the certificate of a run (REQ-VER-15): only from a complete audit trail (REQ-VER-16/AC4); every covered file
 * becomes a subject, the predicate holds the Merkle root, the approved plan, approvals, manifest, matrix and report
 * hashes, tool versions, image digests, the tested environment, the decision and the time; the statement is signed
 * with the project key into `certificate/certificate.dsse.json`, and `report.html` gets the certificate section. A
 * valid certificate of the same files and key is reused, so publishing again keeps its id.
 *
 * @param session - The run.
 * @param now - Clock.
 * @param verdict - The GO / NO-GO line and the status of each case, computed from the files now (REQ-VER-15/AC8):
 *   never the statuses recorded in `run.json`, which the certificate does not cover.
 */
export async function issueCertificate(
  session: RunSession,
  now: () => Date,
  verdict: CertifiedVerdict,
  fetchImpl?: typeof globalThis.fetch,
): Promise<IssueOutcome> {
  const outcome = await issueOrReuse(session, now, verdict);
  if (outcome.status !== "issued" || fetchImpl === undefined) return outcome;
  // REQ-VER-17: a configured TSA stamps the certificate; a TSA that cannot help never stops the run (AC5).
  const timestamp = await stampCertificate(session, fetchImpl, now);
  // REQ-VER-19: then the run goes to write-once storage, timestamp included; an archive that cannot help never stops it.
  const archived = await archiveRun(session, fetchImpl, now);
  return {
    ...outcome,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(archived === undefined ? {} : { archived }),
  };
}

async function issueOrReuse(
  session: RunSession,
  now: () => Date,
  verdict: CertifiedVerdict,
): Promise<IssueOutcome> {
  const key = await signingKey(session);
  if (key === undefined) return { status: "off" };
  const { ws, events } = session;
  const loaded = await loadAuditTrail(session);
  if (loaded.trail.gaps.length > 0) {
    events.emit("certificate", { kind: "system", name: "verifier" }, "certificate.refused", {
      gaps: loaded.trail.gaps.slice(0, 50),
    });
    return { status: "gaps", gaps: loaded.trail.gaps };
  }
  const read = readRunFile(ws.dir);
  const publicKey = createPublicKey(key);
  const existing = await readFile(
    ws.path(...(CERTIFICATE_FILE.split("/") as [string, string])),
    "utf8",
  ).catch(() => undefined);
  if (existing !== undefined) {
    const files = new Map<string, Uint8Array>();
    for (const i of loaded.trail.items) files.set(i.path, await read(i.path));
    const envelope = JSON.parse(existing) as DsseEnvelope;
    const check = checkCertificate(envelope, [publicKey], (p) => files.get(p));
    const covered = loaded.trail.items.filter((i) => certificateScope(i.path) !== "excluded").length;
    // A file changed or removed after the run was certified: a new certificate would launder the change.
    // Reports and checks are rendered by code from the other files, so they may be rendered again.
    const altered = [...check.changed, ...check.missing].filter(
      (f) => !f.startsWith("report/") && !f.startsWith("checks/"),
    );
    if (check.problems.length === 0 && altered.length > 0) {
      const gaps = altered.map((f) => `${f} changed after certificate ${certificateId(envelope)} was issued`);
      events.emit("certificate", { kind: "system", name: "verifier" }, "certificate.refused", { gaps });
      return { status: "gaps", gaps };
    }
    if (check.problems.length === 0 && check.statement?.subject.length === covered) {
      const certificate = {
        id: certificateId(envelope),
        merkleRoot: check.statement.predicate.merkleRoot,
        keyId: keyIdOf(publicKey),
      };
      await stampReport(session, certificate);
      return { status: "issued", certificate, reused: true };
    }
  }
  const subjects: CertificateSubject[] = [];
  for (const i of loaded.trail.items)
    if (certificateScope(i.path) !== "excluded")
      subjects.push(certificateSubject(i.path, await read(i.path)));
  const digest = (name: string): string | undefined => subjects.find((s) => s.name === name)?.digest.sha256;
  const issuedAt = now().toISOString();
  const data = ws.record.data;
  const build = (data["build"] ?? {}) as Record<string, unknown>;
  const statement = certificateStatement(subjects, {
    ticket: ws.ticket,
    runId: ws.runId,
    issuedAt,
    files: subjects.length,
    repos: ws.record.repos,
    plan: data["approval"],
    approvals: data["approvals"] ?? [],
    planSha256: digest("plan/plan.approved.yaml"),
    manifestSha256: digest("evidence/manifest.json"),
    matrixSha256: digest("report/matrix.md"),
    reportSha256: digest("report/report.html"),
    statuses: verdict.statuses,
    decision: verdict.decision,
    versions: data["versions"],
    images: build["images"] ?? [],
    environment: data["environment"],
    ...(data["codeAccess"] ? { codeAccess: data["codeAccess"] } : {}),
    ...storageOf(session, issuedAt),
  });
  const envelope = signStatement(statement, keySigner(key));
  await mkdir(ws.path(CERTIFICATE_DIR), { recursive: true });
  await writeFile(
    ws.path(...(CERTIFICATE_FILE.split("/") as [string, string])),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  const certificate = {
    id: certificateId(envelope),
    merkleRoot: statement.predicate.merkleRoot,
    keyId: keyIdOf(key),
  };
  // The signer's public key next to the certificate, for convenience; a verifier trusts only keys it was given.
  await writeFile(
    ws.path(CERTIFICATE_DIR, `${certificate.keyId.slice(0, 16)}.pub`),
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  await ws.update({ data: { ...ws.record.data, certificate: { ...certificate, at: now().toISOString() } } });
  events.emit("certificate", { kind: "system", name: "verifier" }, "certificate.issued", {
    ...certificate,
    files: subjects.length,
  });
  await stampReport(session, certificate);
  return { status: "issued", certificate, reused: false };
}

/** The write-once storage a new certificate states (REQ-VER-19/AC3). */
const storageOf = (session: RunSession, issuedAt: string): { storage?: unknown } => {
  const storage = plannedStorage(
    session.project.config.archive,
    session.ws.ticket,
    session.ws.runId,
    issuedAt,
  );
  return storage === undefined ? {} : { storage };
};

/** Writes the certificate section into `report.html` (REQ-VER-15/AC7); the covered content stays the same. */
async function stampReport(session: Pick<RunSession, "ws">, certificate: CertificateSummary): Promise<void> {
  const path = session.ws.path("report", "report.html");
  const html = await readFile(path, "utf8").catch(() => undefined);
  if (html === undefined) return;
  const { covered, block } = splitCertificateBlock(html);
  if (block === undefined) return;
  await writeFile(
    path,
    covered.replace(renderCertificateBlock(), renderCertificateBlock(certificate)),
    "utf8",
  );
}

/** Lines that say how to check a certificate (REQ-VER-15/AC7), for the terminal and the ticket comment. */
export function certificateLines(c: CertificateSummary): string[] {
  return [
    `Certificate ${c.id}, Merkle root ${c.merkleRoot}, signed with key ${c.keyId.slice(0, 16)}.`,
    "Verify the run folder or its audit export with: qj verify-report <path> --key <public key>",
  ];
}

/**
 * Issues the certificate while publishing (REQ-VER-15/AC1): a trail with gaps gives no certificate; with
 * `certificate.required` it stops the publication (REQ-VER-16/AC4).
 *
 * @returns Lines for the ticket comment.
 * @throws {GateFailedError} `PUBLISH_GATES_FAILED` when a required certificate cannot be issued.
 */
export async function certificateForPublish(
  session: RunSession,
  io: CommandIO,
  now: () => Date,
  verdict: CertifiedVerdict,
  fetchImpl?: typeof globalThis.fetch,
): Promise<string[]> {
  const outcome = await issueCertificate(session, now, verdict, fetchImpl);
  if (outcome.status === "off") return [];
  if (outcome.status === "gaps") {
    if (session.project.config.certificate.required)
      throw new GateFailedError(
        "PUBLISH_GATES_FAILED",
        `No certificate: the audit trail has ${String(outcome.gaps.length)} gap(s): ${outcome.gaps.slice(0, 3).join("; ")}. Run qj audit trail for all of them.`,
        { gates: ["certificate"] },
      );
    // The reasons themselves, not a pointer: a file changed after an earlier certificate is not a gap of the trail.
    io.writeError(
      `Warning: no certificate, the audit trail has ${String(outcome.gaps.length)} gap(s):\n${outcome.gaps
        .slice(0, 5)
        .map((g) => `  - ${g}\n`)
        .join(
          "",
        )}${outcome.gaps.length > 5 ? `  … qj audit trail ${session.ws.ticket} lists all of them.\n` : ""}`,
    );
    return [`No certificate: the audit trail has ${String(outcome.gaps.length)} gap(s).`];
  }
  // The lines go into the comment, whose preview is printed; printing them here too repeated them.
  return [
    ...certificateLines(outcome.certificate),
    ...(outcome.timestamp ? [outcome.timestamp] : []),
    ...(outcome.archived ? [outcome.archived] : []),
  ];
}

/**
 * `qajitsu audit certify <TICKET> [--run <id>]`: issues the run's certificate without publishing (REQ-VER-15).
 *
 * @returns 0 issued, 1 the trail has gaps (no certificate), 3 errors or no signing key configured.
 */
export async function runCertify(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    if (session.ws.record.data["results"] === undefined)
      throw new ConfigError("RUN_NOT_EXECUTED", "This run has no results yet; run 'qajitsu run' first.", {});
    // The reports are rendered by code from the run's files first, so a hand-edited report is never certified.
    const verdict = await computeVerdict(session, ports.now);
    await writeReports(session, verdict);
    const outcome = await issueCertificate(session, ports.now, certifiedVerdict(verdict), ports.fetch);
    if (outcome.status === "off")
      throw new ConfigError(
        "CERTIFICATE_KEY_MISSING",
        "No signing key: create one with qj audit keygen and set certificate.signing_key in .qa/qa.project.yaml.",
        {},
      );
    if (outcome.status === "gaps") {
      io.write(
        `✘ No certificate: the audit trail has ${String(outcome.gaps.length)} gap(s):\n${outcome.gaps.map((g) => `  - ${g}`).join("\n")}\n`,
      );
      return 1;
    }
    io.write(
      `${outcome.reused ? "The run's certificate is still valid" : "Issued"}: ${session.ws.path(...(CERTIFICATE_FILE.split("/") as [string, string]))}\n${[...certificateLines(outcome.certificate), ...(outcome.timestamp ? [outcome.timestamp] : []), ...(outcome.archived ? [outcome.archived] : [])].join("\n")}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}

/**
 * `qajitsu audit keygen`: creates an Ed25519 signing key (REQ-VER-15/AC6). The private key is written with mode 0600
 * into the project home, never printed; the public key goes to `.qa/keys/<id>.pub` to be committed. Older public keys
 * stay there, so certificates they signed keep verifying after a rotation.
 *
 * @returns 0 created, 3 errors.
 */
export async function runKeygen(io: CommandIO, ports: RuntimePorts): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const id = keyIdOf(publicKey);
    const privateDir = join(project.project?.paths.home ?? join(ports.home, ".qajitsu"), KEYS_DIR);
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    const privatePath = join(privateDir, `${id.slice(0, 16)}.key`);
    await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
      mode: 0o600,
    });
    await chmod(privatePath, 0o600);
    const publicDir = join(project.qaDir, KEYS_DIR);
    await mkdir(publicDir, { recursive: true });
    const publicPath = join(publicDir, `${id.slice(0, 16)}.pub`);
    await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString());
    io.write(
      [
        `Signing key ${id.slice(0, 16)} created.`,
        `Public key (commit it; keep older ones for rotation): ${publicPath}`,
        `Private key (mode 0600): ${privatePath}`,
        "Next: put the private key into your secret provider, for example as an environment variable in base64:",
        `  base64 < ${privatePath}   → QAJITSU_SIGNING_KEY in .env.local or the CI secret store`,
        "then set in .qa/qa.project.yaml:",
        "  certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }",
        "and delete the private key file once it is stored.",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

/** A run folder or an audit export (zip) as run-relative files. */
export interface RunFiles {
  readonly read: (path: string) => Uint8Array | undefined;
  readonly paths: readonly string[];
  /** Names an archive holds twice: what a tool unpacks may differ from what was checked. */
  readonly duplicates: readonly string[];
  readonly archive: boolean;
}

export async function openRunFiles(path: string): Promise<RunFiles> {
  if ((await stat(path)).isDirectory()) {
    const files = new Map<string, Uint8Array>();
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        // Symbolic links are not followed: a covered file replaced by a link counts as missing.
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
        else if (entry.isFile()) files.set(rel, new Uint8Array(await readFile(join(dir, entry.name))));
      }
    };
    await walk(path, "");
    return { read: (p) => files.get(p), paths: [...files.keys()], duplicates: [], archive: false };
  }
  const entries = unzip(new Uint8Array(await readFile(path)), { maxEntries: 100_000 });
  const files = new Map<string, Uint8Array>();
  const duplicates: string[] = [];
  for (const e of entries) {
    if (files.has(e.name)) duplicates.push(e.name);
    files.set(e.name, e.data);
  }
  return { read: (p) => files.get(p), paths: [...files.keys()], duplicates, archive: true };
}

/** Prints a certificate check with what else the folder holds; returns whether it passed. */
function reportCheck(
  io: CommandIO,
  check: CertificateCheck,
  extra: {
    readonly added: readonly string[];
    readonly grown: readonly { name: string; bytes: number }[];
    readonly problems: readonly string[];
    readonly keySource?: string | undefined;
    /** Lines about the timestamp (REQ-VER-17). */
    readonly notes?: readonly string[];
  },
): boolean {
  const failures = [
    ...check.problems,
    ...extra.problems,
    ...check.changed.map((f) => `changed: ${f}`),
    ...check.missing.map((f) => `missing: ${f}`),
    ...extra.added.map((f) => `added after the certificate: ${f}`),
  ];
  const p = check.statement?.predicate;
  const what = p ? `${p.ticket} run ${p.runId}, issued ${p.issuedAt}` : "";
  const grown = [
    ...(extra.notes ?? []).map((n) => `  ${n}\n`),
    ...extra.grown.map(
      (g) => `  ${g.name}: ${String(g.bytes)} byte(s) written after the certificate (not covered)\n`,
    ),
  ];
  if (failures.length === 0) {
    io.write(
      `✔ Certificate ${check.id ?? ""} is valid: ${what}\n  ${String(check.statement?.subject.length ?? 0)} files unchanged, Merkle root ${p?.merkleRoot ?? ""}\n  signed with trusted key ${(check.keyId ?? "").slice(0, 16)}${extra.keySource ? ` (from ${extra.keySource})` : ""}\n${p?.decision === undefined ? "" : `  ${p.decision}\n`}${grown.join("")}`,
    );
    return true;
  }
  io.write(
    `✘ Certificate ${check.id ?? ""} does NOT verify${what ? ` (${what})` : ""}:\n${failures.map((l) => `  - ${l}`).join("\n")}\n${grown.join("")}`,
  );
  return false;
}

/**
 * `qajitsu verify-report <path> [--key <file>...]`: checks the certificate of a run folder or an audit export
 * (REQ-VER-15/AC3): the signature with a trusted key, the Merkle root and every covered file. Trusted keys are the
 * `--key` files and, inside a project, `.qa/keys/*.pub`. Works offline, without the run's project.
 *
 * @returns 0 valid, 1 changed, missing or untrusted, 3 errors (no certificate, unreadable path).
 */
export async function runVerifyReport(
  path: string,
  options: { readonly key?: readonly string[] | undefined; readonly tsaCa?: readonly string[] | undefined },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const files = await openRunFiles(resolve(io.cwd, path));
    const { read } = files;
    const raw = read(CERTIFICATE_FILE);
    if (raw === undefined)
      throw new ConfigError("CERTIFICATE_NOT_FOUND", `No ${CERTIFICATE_FILE} in ${path}.`, {});
    let envelope: DsseEnvelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(raw)) as DsseEnvelope;
    } catch {
      throw new ConfigError("CERTIFICATE_INVALID", `${CERTIFICATE_FILE} is not JSON.`, {});
    }
    // Where the trust in each key comes from is shown with the result (REQ-VER-15/AC9): whoever can write to
    // .qa/keys/ can add a key, so an outside auditor passes the key they got from the project with --key.
    const keys: { key: KeyObject; source: string }[] = [];
    for (const k of options.key ?? []) {
      try {
        keys.push({ key: createPublicKey(await readFile(resolve(io.cwd, k), "utf8")), source: `--key ${k}` });
      } catch {
        throw new ConfigError("CERTIFICATE_KEY_INVALID", `${k} is not a public key in PEM.`, {});
      }
    }
    const project = ports.project
      ? await loadProject(io.cwd, ports.project).catch(() => undefined)
      : undefined;
    if (project) keys.push(...(await publicKeysIn(join(project.qaDir, KEYS_DIR))));
    const check = checkCertificate(
      envelope,
      keys.map((k) => k.key),
      read,
    );
    const problems = files.duplicates.map((d) => `the archive has two entries named ${d}`);
    // run.json is not covered, but it names the run: a certificate shown with another run's folder is refused.
    const p = check.statement?.predicate;
    const runRecord = read("run.json");
    if (p && runRecord) {
      try {
        const r = JSON.parse(new TextDecoder().decode(runRecord)) as { ticket?: unknown; runId?: unknown };
        if (r.ticket !== p.ticket || r.runId !== p.runId)
          problems.push(
            `the certificate is for ${p.ticket} run ${p.runId}, the folder is ${String(r.ticket)} run ${String(r.runId)}`,
          );
      } catch {
        problems.push("run.json is not JSON");
      }
    }
    const coverage = check.statement
      ? certificateCoverage(
          check.statement,
          files.paths,
          read,
          files.archive ? new Set(["SHA256SUMS", "README.txt"]) : new Set(),
        )
      : { added: [], grown: [] };
    const keySource = keys.find((k) => keyIdOf(k.key) === check.keyId)?.source;
    // REQ-VER-17/AC3: a token present must check; a TSA nobody trusts is said, not hidden.
    const notes: string[] = [];
    const token = read(`${CERTIFICATE_DIR}/${TIMESTAMP_TOKEN}`);
    if (token === undefined) notes.push("not timestamped");
    else {
      const tsaCas: X509Certificate[] = [];
      for (const f of options.tsaCa ?? []) {
        try {
          tsaCas.push(new X509Certificate(await readFile(resolve(io.cwd, f))));
        } catch {
          throw new ConfigError("TSA_CA_INVALID", `${f} is not a certificate in PEM or DER.`, {});
        }
      }
      if (project) tsaCas.push(...(await trustedTsaCertificates(project)));
      const ts = checkTimestampToken(Buffer.from(token), payloadDigest(envelope), { trusted: tsaCas });
      const issuedAt = check.statement ? Date.parse(check.statement.predicate.issuedAt) : Number.NaN;
      const stampedAt = ts.genTime === undefined ? Number.NaN : Date.parse(ts.genTime);
      if (!ts.ok) problems.push(...ts.problems.map((p) => `timestamp: ${p}`));
      // A timestamp proves the certificate existed by then: one claiming a later issue time is dated falsely.
      else if (stampedAt + 5 * 60_000 < issuedAt)
        problems.push(
          `timestamp: the certificate claims to be issued ${check.statement?.predicate.issuedAt ?? ""}, after its timestamp ${ts.genTime ?? ""}`,
        );
      else {
        if (stampedAt - issuedAt > 24 * 3_600_000)
          notes.push(
            `stamped ${String(Math.round((stampedAt - issuedAt) / 3_600_000))} h after the certificate was issued: it proves the certificate existed by then, not earlier`,
          );
        notes.push(
          `timestamped ${ts.genTime ?? ""} by ${ts.tsa ?? "a TSA"}${ts.trusted ? " (trusted TSA)" : "; the TSA is not trusted here (pass its CA with --tsa-ca)"}`,
        );
      }
    }
    // REQ-VER-19/AC3: where the certificate says the run is kept write-once, and what QAJitsu recorded about it.
    const storage = check.statement?.predicate.storage;
    if (storage) {
      const record = read(`${CERTIFICATE_DIR}/archive.json`);
      let status = "not archived yet";
      try {
        const r = record
          ? (JSON.parse(new TextDecoder().decode(record)) as { status?: string; reason?: string })
          : undefined;
        if (r?.status === "archived") status = "archived";
        else if (r?.status === "not_archived") status = `not archived: ${r.reason ?? ""}`;
      } catch {
        status = "archive record unreadable";
      }
      notes.push(
        `kept write-once at ${storage.location} (${storage.mode}) until ${storage.retainUntil}; ${status}`,
      );
    }
    return reportCheck(io, check, { ...coverage, problems, keySource, notes }) ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
