import { ConfigError } from "@qajitsu/core";
import { QAJITSU_IMAGE, withTag, type PinnedImage, type PinnedModel } from "./images.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?::[\w.-]+)?$/;
const IMAGE_REF = /^([a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/[a-z0-9._-]+)+)(?::([\w.-]+))?@(sha256:[0-9a-f]{64})$/;

/**
 * The QAJitsu release image of a version, by the digest of its image index (REQ-GEN-10/AC4), asked from GHCR with an
 * anonymous pull token.
 *
 * @param version - The CLI's version: the image of the same release.
 * @param fetch - Injected fetch.
 * @throws {ConfigError} `STACK_IMAGE_UNPUBLISHED` when GHCR has no such image or names no digest.
 */
export async function resolveQajitsuImage(
  version: string,
  fetch: typeof globalThis.fetch,
): Promise<PinnedImage> {
  const path = QAJITSU_IMAGE.replace(/^ghcr\.io\//, "");
  const unpublished = (why: string) =>
    new ConfigError(
      "STACK_IMAGE_UNPUBLISHED",
      `${QAJITSU_IMAGE}:${version} is not published (${why}); give the image by digest with --image <ref@sha256:...>.`,
      { version },
    );
  try {
    const token = (await (
      await fetch(`https://ghcr.io/token?scope=${encodeURIComponent(`repository:${path}:pull`)}`)
    ).json()) as { token?: unknown };
    const response = await fetch(`https://ghcr.io/v2/${path}/manifests/${version}`, {
      method: "HEAD",
      headers: {
        ...(typeof token.token === "string" ? { authorization: `Bearer ${token.token}` } : {}),
        accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
    });
    if (!response.ok) throw unpublished(`GHCR answered ${String(response.status)}`);
    const digest = response.headers.get("docker-content-digest") ?? "";
    if (!DIGEST.test(digest)) throw unpublished("GHCR named no sha256 digest");
    return { repository: QAJITSU_IMAGE, version, digest };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw unpublished(error instanceof Error ? error.message : String(error));
  }
}

/**
 * An image given by hand (`--image`): `repository[:tag]@sha256:...`. A tag alone is refused, since it may point to
 * another image tomorrow.
 *
 * @throws {ConfigError} `STACK_IMAGE_NOT_PINNED`.
 */
export function parsePinnedImage(reference: string): PinnedImage {
  const m = IMAGE_REF.exec(reference);
  if (!m)
    throw new ConfigError(
      "STACK_IMAGE_NOT_PINNED",
      `--image ${reference} has no sha256 digest; give it as <repository>[:<tag>]@sha256:<64 hex>.`,
      { reference },
    );
  return { repository: m[1] ?? "", version: m[2] ?? "unknown", digest: m[3] ?? "" };
}

/**
 * A model given by hand as `name[:tag]@sha256:...` (`--model role=...`); undefined when it carries no digest, so its
 * digest is resolved from the registry.
 *
 * @throws {ConfigError} `STACK_MODEL_INVALID` for a malformed name or digest.
 */
export function parsePinnedModel(value: string): PinnedModel | undefined {
  const at = value.indexOf("@");
  const name = at < 0 ? value : value.slice(0, at);
  if (!MODEL_NAME.test(name))
    throw new ConfigError("STACK_MODEL_INVALID", `${name} is not an Ollama model name.`, { model: name });
  if (at < 0) return undefined;
  const digest = value.slice(at + 1);
  if (!DIGEST.test(digest))
    throw new ConfigError("STACK_MODEL_INVALID", `${value}: the digest is not sha256:<64 hex>.`, {
      model: name,
    });
  return { name: withTag(name), digest };
}
