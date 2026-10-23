import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createS3Archive } from "@qajitsu/adapter-evidence-s3";
import {
  CERTIFICATE_DIR,
  CERTIFICATE_FILE,
  ConfigError,
  QajitsuError,
  type DsseEnvelope,
  type EvidenceArchive,
  type ProjectConfig,
  type RetentionMode,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import { buildAuditExport } from "./audit-trail.js";
import type { CommandIO } from "./fetch.js";

/** What QAJitsu recorded about the write-once copy of a run (`certificate/archive.json`). */
export type ArchiveRecord =
  | {
      readonly status: "archived";
      readonly certificate: string;
      readonly location: string;
      readonly mode: RetentionMode;
      readonly retainUntil: string;
      readonly objects: readonly {
        readonly key: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly versionId?: string;
      }[];
      readonly at: string;
    }
  | { readonly status: "not_archived"; readonly reason: string; readonly at: string };

/** The planned storage of a run, as its certificate states it (REQ-VER-19/AC3). */
export interface PlannedStorage {
  readonly kind: "s3-object-lock";
  readonly location: string;
  readonly mode: RetentionMode;
  readonly retainUntil: string;
}

type ArchiveConfig = NonNullable<ProjectConfig["archive"]>;

const prefixOf = (config: ArchiveConfig, ticket: string, runId: string): string =>
  `${config.prefix}${ticket}/${runId}/`;

/**
 * Where a run will be kept write-once and until when, written into its certificate before it is signed
 * (REQ-VER-19/AC3); nothing without an `archive` configuration.
 */
export function plannedStorage(
  config: ProjectConfig["archive"],
  ticket: string,
  runId: string,
  issuedAt: string,
): PlannedStorage | undefined {
  if (!config) return undefined;
  return {
    kind: "s3-object-lock",
    location: `s3://${config.bucket}/${prefixOf(config, ticket, runId)}`,
    mode: config.mode,
    retainUntil: new Date(Date.parse(issuedAt) + config.retention_days * 86_400_000).toISOString(),
  };
}

/** The project's write-once storage, credentials from the secret provider. */
function archiveOf(
  session: Pick<RunSession, "project" | "resolveSecret">,
  fetchImpl: typeof globalThis.fetch,
  now: () => Date,
): EvidenceArchive | undefined {
  const config = session.project.config.archive;
  if (!config) return undefined;
  return createS3Archive(
    { endpoint: config.endpoint, region: config.region, bucket: config.bucket, pathStyle: config.path_style },
    {
      fetch: fetchImpl,
      now,
      credentials: async () => ({
        accessKeyId: await session.resolveSecret(config.access_key_id),
        secretAccessKey: await session.resolveSecret(config.secret_access_key),
        ...(config.session_token === undefined
          ? {}
          : { sessionToken: await session.resolveSecret(config.session_token) }),
      }),
    },
  );
}

const ARCHIVE_RECORD = "archive.json";

/**
 * Keeps a certified run write-once (REQ-VER-19/AC1): its audit export (every file, the trail, `SHA256SUMS`, the
 * certificate and its timestamp) and the certificate itself go to the archive locked until the date the certificate
 * states, then each object is read back to confirm the storage holds that lock. An archive that cannot help never stops
 * the run: `certificate/archive.json` says "not archived" with the reason, and `qj audit archive` tries again.
 *
 * @returns A line for the terminal, or nothing without an `archive` configuration or a certificate that plans one.
 */
export async function archiveRun(
  session: RunSession,
  fetchImpl: typeof globalThis.fetch,
  now: () => Date,
  options: { readonly force?: boolean } = {},
): Promise<string | undefined> {
  const archive = archiveOf(session, fetchImpl, now);
  const config = session.project.config.archive;
  if (!archive || !config) return undefined;
  const { ws, events, masker } = session;
  const raw = await readFile(ws.path(...(CERTIFICATE_FILE.split("/") as [string, string])), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return undefined;
  const envelope = JSON.parse(raw) as DsseEnvelope;
  const certificateId = createHash("sha256").update(Buffer.from(envelope.payload, "base64")).digest("hex");
  const storage = (
    JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      predicate?: { storage?: PlannedStorage };
    }
  ).predicate?.storage;
  // A certificate issued before the archive was configured states no storage: it is not archived under a claim it
  // never made.
  if (!storage) return undefined;
  const recordPath = ws.path(CERTIFICATE_DIR, ARCHIVE_RECORD);
  const existing = await readFile(recordPath, "utf8")
    .then((t) => JSON.parse(t) as ArchiveRecord)
    .catch(() => undefined);
  if (existing?.status === "archived" && existing.certificate === certificateId && options.force !== true)
    return archiveLine(existing);
  const system = { kind: "system", name: "verifier" } as const;
  const notArchived = async (reason: string): Promise<string> => {
    const record: ArchiveRecord = {
      status: "not_archived",
      reason: masker.maskText(reason),
      at: now().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    events.emit("certificate", system, "archive.failed", { reason: record.reason });
    return archiveLine(record);
  };
  if (Date.parse(storage.retainUntil) <= now().getTime())
    return notArchived(`the retention the certificate states ended ${storage.retainUntil}`);
  try {
    const prefix = prefixOf(config, ws.ticket, ws.runId);
    const exported = await buildAuditExport(session, now);
    const items = [
      { key: `${prefix}audit.zip`, data: exported.data },
      { key: `${prefix}certificate.dsse.json`, data: new TextEncoder().encode(raw) },
    ];
    const objects: { key: string; sha256: string; bytes: number; versionId?: string }[] = [];
    for (const item of items) {
      const put = await archive.put(item.key, item.data, {
        mode: storage.mode,
        retainUntil: storage.retainUntil,
      });
      const held = await archive.head(item.key);
      const md5 = createHash("md5").update(item.data).digest("hex");
      // The storage must hold this content under this lock, not merely have answered 200.
      if (!held) return await notArchived(`${item.key} is not in the archive after it was written`);
      if (held.mode !== storage.mode || held.retainUntil === undefined)
        return await notArchived(
          `${item.key} is stored without a ${storage.mode} lock (is Object Lock enabled?)`,
        );
      if (Date.parse(held.retainUntil) < Date.parse(storage.retainUntil))
        return await notArchived(`${item.key} is locked only until ${held.retainUntil}`);
      if (held.md5 !== undefined && held.md5 !== md5)
        return await notArchived(`${item.key} in the archive differs from what was written`);
      objects.push({
        key: item.key,
        sha256: createHash("sha256").update(item.data).digest("hex"),
        bytes: item.data.byteLength,
        ...(put.versionId === undefined ? {} : { versionId: put.versionId }),
      });
    }
    const record: ArchiveRecord = {
      status: "archived",
      certificate: certificateId,
      location: storage.location,
      mode: storage.mode,
      retainUntil: storage.retainUntil,
      objects,
      at: now().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await ws.update({
      data: { ...ws.record.data, archive: { location: storage.location, retainUntil: storage.retainUntil } },
    });
    events.emit("certificate", system, "archive.stored", {
      location: record.location,
      mode: record.mode,
      retainUntil: record.retainUntil,
      objects: objects.map((o) => ({ key: o.key, sha256: o.sha256 })),
    });
    return archiveLine(record);
  } catch (error) {
    return notArchived(error instanceof Error ? error.message : String(error));
  }
}

/** One line about a run's write-once copy. */
export function archiveLine(record: ArchiveRecord): string {
  if (record.status === "not_archived")
    return `Not archived (${record.reason}); try again with qj audit archive.`;
  return `Archived write-once at ${record.location} (${record.mode}) until ${record.retainUntil}.`;
}

/**
 * Until when a run is locked in write-once storage (REQ-VER-19/AC2), from its `run.json`; nothing when it is not or
 * the lock has ended.
 */
export function lockedUntil(data: Readonly<Record<string, unknown>>, now: Date): string | undefined {
  const until = (data["archive"] as { retainUntil?: unknown } | undefined)?.retainUntil;
  return typeof until === "string" && Date.parse(until) > now.getTime() ? until : undefined;
}

/**
 * `qj audit archive <TICKET> [--run <id>]` (REQ-VER-19): keeps a certified run write-once, for example after the
 * archive was unreachable when the run ended.
 *
 * @returns 0 archived, 1 not archived (the reason is printed), 3 errors.
 */
export async function runAuditArchive(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    if (!session.project.config.archive)
      throw new ConfigError(
        "ARCHIVE_NOT_CONFIGURED",
        "Configure archive (S3 Object Lock) in .qa/qa.project.yaml.",
        {},
      );
    const line = await archiveRun(session, ports.fetch, ports.now, { force: true });
    if (line === undefined)
      throw new ConfigError(
        "ARCHIVE_NOT_PLANNED",
        "This run has no certificate stating write-once storage; qj audit certify issues one with the archive configured.",
        {},
      );
    io.write(`${line}\n`);
    return line.startsWith("Archived") ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
