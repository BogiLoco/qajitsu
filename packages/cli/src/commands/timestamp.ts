import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CERTIFICATE_DIR,
  CERTIFICATE_FILE,
  ConfigError,
  QajitsuError,
  type DsseEnvelope,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { checkTimestampToken, parseTimestampResponse, timestampRequest } from "@qajitsu/verifier";
import type { RuntimePorts } from "../adapters.js";
import type { LoadedProject } from "../project.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** The token of a certificate's timestamp (RFC 3161 TimeStampToken, DER). */
export const TIMESTAMP_TOKEN = "timestamp.tsr";
/** What QAJitsu recorded about the timestamp, or why there is none. */
export const TIMESTAMP_RECORD = "timestamp.json";
/** Folder of the TSA CA certificates a project trusts, under `.qa/keys/`. */
export const TSA_KEYS_DIR = join("keys", "tsa");

/** `certificate/timestamp.json`. */
export type TimestampRecord =
  | {
      readonly status: "timestamped";
      readonly url: string;
      /** SHA-256 of the certificate's payload (the signed statement), the only thing sent. */
      readonly digest: string;
      readonly genTime: string;
      readonly serial?: string;
      readonly tsa?: string;
      readonly qualified: boolean;
      readonly trusted: boolean;
    }
  | {
      readonly status: "not_timestamped";
      readonly url: string;
      readonly reason: string;
      readonly at: string;
    };

/** SHA-256 of a certificate's payload: what a timestamp vouches for (the statement holds the Merkle root). */
export const payloadDigest = (envelope: DsseEnvelope): Buffer =>
  createHash("sha256").update(Buffer.from(envelope.payload, "base64")).digest();

/** TSA CA certificates in `.qa/keys/tsa/*.pem|*.crt` (REQ-VER-17/AC3). */
export async function trustedTsaCertificates(
  project: Pick<LoadedProject, "qaDir">,
): Promise<X509Certificate[]> {
  const dir = join(project.qaDir, TSA_KEYS_DIR);
  const out: X509Certificate[] = [];
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort())
    if (/\.(pem|crt|cer)$/.test(name))
      for (const block of (await readFile(join(dir, name), "utf8")).match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      ) ?? [])
        try {
          out.push(new X509Certificate(block));
        } catch {
          // Not a certificate: ignored, so it trusts nothing.
        }
  return out;
}

/**
 * Timestamps the run's certificate at the configured TSA (REQ-VER-17): only the SHA-256 of the signed statement is
 * sent (AC4); the token is checked before it is kept in `certificate/timestamp.tsr` (AC3). When the TSA cannot be
 * reached or answers with something unusable, the run goes on and `certificate/timestamp.json` says "not
 * timestamped" with the reason, to be stamped later with `qj audit timestamp` (AC5).
 *
 * @returns A line for the terminal and the ticket comment, or nothing without a configured TSA.
 */
export async function stampCertificate(
  session: Pick<RunSession, "ws" | "project" | "events" | "masker">,
  fetchImpl: typeof globalThis.fetch,
  now: () => Date,
  options: { readonly force?: boolean } = {},
): Promise<string | undefined> {
  const config = session.project.config.certificate.timestamp;
  if (!config) return undefined;
  const { ws, events, masker } = session;
  const envelope = JSON.parse(
    await readFile(ws.path(...(CERTIFICATE_FILE.split("/") as [string, string])), "utf8"),
  ) as DsseEnvelope;
  const digest = payloadDigest(envelope);
  const recordPath = ws.path(CERTIFICATE_DIR, TIMESTAMP_RECORD);
  const existing = await readFile(recordPath, "utf8")
    .then((t) => JSON.parse(t) as TimestampRecord)
    .catch(() => undefined);
  if (
    existing?.status === "timestamped" &&
    existing.digest === digest.toString("hex") &&
    options.force !== true
  )
    return timestampLine(existing);
  const system = { kind: "system", name: "verifier" } as const;
  const notStamped = async (reason: string): Promise<string> => {
    const record: TimestampRecord = {
      status: "not_timestamped",
      url: config.url,
      reason: masker.maskText(reason),
      at: now().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    events.emit("certificate", system, "certificate.not_timestamped", {
      url: config.url,
      reason: record.reason,
    });
    return timestampLine(record);
  };
  const nonce = randomBytes(8);
  let body: Buffer;
  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
      body: timestampRequest(digest, nonce),
      signal: AbortSignal.timeout(config.timeout_s * 1000),
    });
    if (!response.ok) return await notStamped(`the TSA answered HTTP ${String(response.status)}`);
    body = Buffer.from(await response.arrayBuffer());
    if (body.length > 64 * 1024) return await notStamped("the TSA's answer is too large");
  } catch (error) {
    return notStamped(
      `the TSA could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: ReturnType<typeof parseTimestampResponse>;
  try {
    parsed = parseTimestampResponse(body);
  } catch {
    return notStamped("the TSA's answer is not a timestamp response");
  }
  if (parsed.token === undefined)
    return notStamped(
      `the TSA refused (status ${String(parsed.status)}${parsed.statusText ? `: ${parsed.statusText}` : ""})`,
    );
  const check = checkTimestampToken(parsed.token, digest, {
    trusted: await trustedTsaCertificates(session.project),
    nonce,
  });
  if (!check.ok || check.genTime === undefined)
    return notStamped(`the TSA's token does not check: ${check.problems.join("; ")}`);
  const issuedAt = (
    JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      predicate?: { issuedAt?: string };
    }
  ).predicate?.issuedAt;
  // The certificate cannot have been issued after the TSA saw it: one of the clocks is wrong.
  if (issuedAt !== undefined && Date.parse(check.genTime) + 5 * 60_000 < Date.parse(issuedAt))
    return notStamped(
      `the TSA's time ${check.genTime} is before the certificate's issue time ${issuedAt}; check this machine's clock`,
    );
  await writeFile(ws.path(CERTIFICATE_DIR, TIMESTAMP_TOKEN), parsed.token);
  const record: TimestampRecord = {
    status: "timestamped",
    url: config.url,
    digest: digest.toString("hex"),
    genTime: check.genTime,
    ...(check.serial === undefined ? {} : { serial: check.serial }),
    ...(check.tsa === undefined ? {} : { tsa: check.tsa }),
    qualified: config.qualified,
    trusted: check.trusted,
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  events.emit("certificate", system, "certificate.timestamped", {
    url: config.url,
    genTime: record.genTime,
    trusted: record.trusted,
    qualified: record.qualified,
  });
  return timestampLine(record);
}

/** One line about a certificate's timestamp. */
export function timestampLine(record: TimestampRecord): string {
  if (record.status === "not_timestamped")
    return `Not timestamped (${record.reason}); stamp it later with qj audit timestamp.`;
  return `Timestamped ${record.genTime} by ${record.tsa ?? record.url}${record.qualified ? " (qualified, eIDAS)" : ""}${record.trusted ? "" : "; the TSA's certificate is not in .qa/keys/tsa/"}.`;
}

/**
 * `qj audit timestamp <TICKET> [--run <id>]` (REQ-VER-17/AC5): timestamps a certificate that was issued while the TSA
 * was unreachable, or stamps it again.
 *
 * @returns 0 timestamped, 1 not timestamped (the reason is printed), 3 errors.
 */
export async function runAuditTimestamp(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    if (!session.project.config.certificate.timestamp)
      throw new ConfigError(
        "TIMESTAMP_NOT_CONFIGURED",
        "Set certificate.timestamp.url to a time-stamping authority.",
        {},
      );
    const has = await readFile(session.ws.path(...(CERTIFICATE_FILE.split("/") as [string, string]))).then(
      () => true,
      () => false,
    );
    if (!has)
      throw new ConfigError(
        "CERTIFICATE_NOT_FOUND",
        "This run has no certificate yet; qj audit certify issues it.",
        {},
      );
    const line = (await stampCertificate(session, ports.fetch, ports.now, { force: true })) ?? "";
    io.write(`${line}\n`);
    return line.startsWith("Timestamped") ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
