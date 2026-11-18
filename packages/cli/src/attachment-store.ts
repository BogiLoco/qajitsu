import type * as S3Plugin from "@qajitsu/adapter-evidence-s3";
import type { AttachmentStore, Publisher } from "@qajitsu/core";
import { pluginFetch, sessionPlugins } from "./commands/plugin.js";
import type { CommandIO } from "./commands/fetch.js";
import type { RunSession } from "./session.js";

/**
 * The project's store for attachments over the ticket's limit (REQ-PUB-02/AC3), from its plugin; undefined without
 * `publish.oversized`.
 *
 * @param session - The run, its project and secrets.
 * @param fetchImpl - The command's fetch.
 * @param now - The command's clock (signing time).
 */
export async function attachmentStoreOf(
  session: Pick<RunSession, "project" | "resolveSecret" | "plugins">,
  fetchImpl: typeof globalThis.fetch,
  now: () => Date,
): Promise<AttachmentStore | undefined> {
  const config = session.project.config.publish.oversized;
  if (!config) return undefined;
  // REQ-GEN-11/AC2: a missing plugin stops publishing with the command that installs it.
  const { createS3AttachmentStore } = await sessionPlugins(session).load<typeof S3Plugin>("evidence-s3");
  return createS3AttachmentStore(
    { endpoint: config.endpoint, region: config.region, bucket: config.bucket, pathStyle: config.path_style },
    {
      // Virtual-hosted addressing talks to <bucket>.<host>: exactly that origin, nothing else under the host.
      fetch: pluginFetch(sessionPlugins(session), fetchImpl, "evidence-s3", [
        config.endpoint,
        ...(config.path_style ? [] : [virtualHostOrigin(config.endpoint, config.bucket)]),
      ]),
      now,
      credentials: async () => ({
        accessKeyId: await session.resolveSecret(config.access_key_id),
        secretAccessKey: await session.resolveSecret(config.secret_access_key),
      }),
    },
  );
}

/**
 * The largest attachment to upload (REQ-PUB-02/AC3): the project's `publish.max_attachment_mb`, lowered to the
 * instance's own limit when the ticket system reports one. A system that cannot say keeps the configured limit.
 *
 * @param maxMb - `publish.max_attachment_mb`.
 * @param publisher - The ticket system.
 * @param io - Where a warning goes.
 * @returns The limit in bytes; 0 when the instance takes no attachments.
 */
export async function attachmentLimitOf(maxMb: number, publisher: Publisher, io: CommandIO): Promise<number> {
  const configured = maxMb * 1_000_000;
  try {
    const instance = await publisher.attachmentLimit?.();
    return instance === undefined ? configured : Math.min(configured, instance);
  } catch {
    io.writeError(
      `Warning: the ticket system did not say how large an attachment may be; using publish.max_attachment_mb (${String(maxMb)} MB).\n`,
    );
    return configured;
  }
}

/**
 * The object key of an attachment: `<prefix><ticket>/<run>/<first 16 hex of its SHA-256>/<name>`, with characters S3
 * keys should not hold replaced. Another content gets another key, so an older comment's link never serves newer
 * bytes under the old hash.
 *
 * @param prefix - `publish.oversized.prefix`.
 */
export const storedKey = (
  prefix: string,
  ticket: string,
  runId: string,
  sha256: string,
  name: string,
): string =>
  `${prefix}${ticket}/${runId}/${sha256.slice(0, 16)}/${name.replace(/[^A-Za-z0-9!_.*'()-]/g, "_")}`;

/** The origin of a virtual-hosted bucket (`https://<bucket>.<host>`). */
const virtualHostOrigin = (endpoint: string, bucket: string): string => {
  const url = new URL(endpoint);
  return `${url.protocol}//${bucket}.${url.host}`;
};

/** The largest file put into object storage: it is read into memory to be signed and hashed. */
export const MAX_STORED_BYTES = 2_000_000_000;

/**
 * Whether a file over the attachment limit goes to object storage (REQ-PUB-02/AC3): not when the ticket system takes
 * no attachments at all (switched off on purpose), and not when it is too large to read into memory.
 *
 * @param bytes - The file's size.
 * @param limit - The attachment limit in bytes; 0 when the instance takes none.
 */
export const storableOversized = (bytes: number, limit: number): boolean =>
  limit > 0 && bytes > limit && bytes <= MAX_STORED_BYTES;
