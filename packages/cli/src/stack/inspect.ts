import { createHash } from "node:crypto";
import { ConfigError } from "@qajitsu/core";
import { withTag, type PinnedModel } from "./images.js";

/** What an Ollama model can do, read from its files in the registry (REQ-GEN-10/AC3). */
export interface ModelFacts extends PinnedModel {
  /** Its chat template passes tools to the model. */
  readonly tools: boolean;
  /** It has a vision projector, or vision weights in the model file. */
  readonly vision: boolean;
  /** The context length the model was trained for (`<architecture>.context_length`). */
  readonly contextWindow: number;
  /** Bytes of the model file. */
  readonly size: number;
  /** Bytes of keys and values per token of context in f16, from the attention shape; undefined when not stated. */
  readonly kvBytesPerToken: number | undefined;
}

/** `OLLAMA_KV_CACHE_TYPE` of the stack: q8_0 keeps about half of f16's bytes (1.0625 of 2 per value). */
export const STACK_KV_CACHE_TYPE = "q8_0";
const Q8_0_OF_F16 = 1.0625 / 2;

/**
 * About how much memory Ollama needs to serve a model at a context length with the stack's q8_0 cache: the model
 * file, the keys and values of every token, and half a gigabyte for the rest.
 *
 * @returns Bytes, or undefined when the model's attention shape is not known.
 */
export function memoryEstimate(model: ModelFacts, contextLength: number): number | undefined {
  if (model.kvBytesPerToken === undefined) return undefined;
  return model.size + model.kvBytesPerToken * Q8_0_OF_F16 * contextLength + 512 * 1024 * 1024;
}

/** Enough of a GGUF file to hold its metadata before the tokenizer's long arrays end the read. */
const HEAD_BYTES = 8 * 1024 * 1024;
/** A manifest or a chat template larger than these is not one. */
const MANIFEST_BYTES = 1024 * 1024;
const TEMPLATE_BYTES = 256 * 1024;

/**
 * At most `limit` bytes of a response body, read as a stream so that a server ignoring `Range` never makes the whole
 * file land in memory. With `cut` the rest is dropped; without it a longer body is refused.
 */
async function readAtMost(response: Response, limit: number, cut: boolean): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    const room = limit - total;
    if (value.length > room) {
      await reader.cancel();
      if (!cut) return undefined;
      chunks.push(value.subarray(0, room));
      total = limit;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/**
 * The metadata of a GGUF file's header that the stack needs: architecture, context length and whether it holds vision
 * weights. Reading stops at the end of the given bytes; a key after that is not seen.
 *
 * @param head - The first bytes of the file.
 * @throws {ConfigError} `STACK_MODEL_UNREADABLE` when it is not a GGUF file.
 */
export function readGgufMetadata(head: Uint8Array): {
  architecture: string | undefined;
  contextLength: number | undefined;
  vision: boolean;
  kvBytesPerToken: number | undefined;
} {
  if (new TextDecoder().decode(head.subarray(0, 4)) !== "GGUF")
    throw new ConfigError("STACK_MODEL_UNREADABLE", "The model file is not a GGUF file.");
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let at = 16; // magic, version, tensor count
  const count = Number(view.getBigUint64(at, true));
  at += 8;
  const text = (): string => {
    const length = Number(view.getBigUint64(at, true));
    at += 8;
    const s = new TextDecoder().decode(head.subarray(at, at + length));
    at += length;
    return s;
  };
  // Byte sizes of GGUF's scalar types; 8 is a string, 9 an array.
  const SIZE: Record<number, number> = {
    0: 1,
    1: 1,
    2: 2,
    3: 2,
    4: 4,
    5: 4,
    6: 4,
    7: 1,
    10: 8,
    11: 8,
    12: 8,
  };
  const value = (type: number): unknown => {
    if (type === 8) return text();
    if (type === 9) {
      const inner = view.getUint32(at, true);
      const n = Number(view.getBigUint64(at + 4, true));
      at += 12;
      if (inner === 8) for (let i = 0; i < n; i++) text();
      else at += n * (SIZE[inner] ?? 0);
      return undefined;
    }
    const v =
      type === 4 ? view.getUint32(at, true) : type === 10 ? Number(view.getBigUint64(at, true)) : undefined;
    at += SIZE[type] ?? 0;
    return v;
  };
  const keys = new Map<string, unknown>();
  try {
    for (let i = 0; i < count; i++) {
      const key = text();
      const type = view.getUint32(at, true);
      at += 4;
      keys.set(key, value(type));
    }
  } catch {
    // The head ended inside the metadata: what was read is what is known.
  }
  const architecture = keys.get("general.architecture");
  const arch = typeof architecture === "string" ? architecture : undefined;
  const context = arch === undefined ? undefined : keys.get(`${arch}.context_length`);
  const num = (key: string): number | undefined => {
    const v = arch === undefined ? undefined : keys.get(`${arch}.${key}`);
    return typeof v === "number" && v > 0 ? v : undefined;
  };
  const blocks = num("block_count");
  const kvHeads = num("attention.head_count_kv") ?? num("attention.head_count");
  const heads = num("attention.head_count");
  const embedding = num("embedding_length");
  const keyLength = num("attention.key_length") ?? (embedding && heads ? embedding / heads : undefined);
  const valueLength = num("attention.value_length") ?? keyLength;
  return {
    architecture: arch,
    contextLength: typeof context === "number" && context > 0 ? context : undefined,
    // Keys and values of every layer, two bytes each in f16.
    kvBytesPerToken:
      blocks && kvHeads && keyLength && valueLength
        ? blocks * kvHeads * (keyLength + valueLength) * 2
        : undefined,
    vision: [...keys.keys()].some(
      (k) => (arch !== undefined && k.startsWith(`${arch}.vision.`)) || k.startsWith("clip."),
    ),
  };
}

/**
 * A model's digest and capabilities from the Ollama registry, without downloading it (REQ-GEN-10/AC3+AC4): the
 * manifest (its SHA-256 is the digest Ollama lists), the chat template (tools) and the first megabytes of the model
 * file (context length, vision).
 *
 * @param name - `name[:tag]`.
 * @param fetch - Injected fetch.
 * @throws {ConfigError} `STACK_MODEL_UNKNOWN` or `STACK_MODEL_UNREADABLE`.
 */
export async function inspectModel(name: string, fetch: typeof globalThis.fetch): Promise<ModelFacts> {
  // Names from qa.project.yaml come here too: only a model name may become a registry path.
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?::[\w.-]+)?$/.test(name) || name.includes(".."))
    throw new ConfigError("STACK_MODEL_INVALID", `${name} is not an Ollama model name.`, { model: name });
  const full = withTag(name);
  const at = full.lastIndexOf(":");
  const repo = full.slice(0, at);
  const path = repo.includes("/") ? repo : `library/${repo}`;
  const base = `https://registry.ollama.ai/v2/${path}`;
  const failed = (code: string, why: string) =>
    new ConfigError(code, `${full} could not be inspected in the Ollama registry: ${why}.`, { model: full });
  const get = async (url: string, init?: RequestInit) => {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw failed("STACK_MODEL_UNKNOWN", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok)
      throw failed("STACK_MODEL_UNKNOWN", `it answered ${String(response.status)} for ${url}`);
    return response;
  };
  const bounded = async (response: Response, limit: number, what: string): Promise<Uint8Array> => {
    const bytes = await readAtMost(response, limit, false);
    if (bytes === undefined)
      throw failed("STACK_MODEL_UNREADABLE", `its ${what} is larger than ${String(limit)} bytes`);
    return bytes;
  };
  const manifestBytes = Buffer.from(
    await bounded(
      await get(`${base}/manifests/${full.slice(at + 1)}`, {
        headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
      }),
      MANIFEST_BYTES,
      "manifest",
    ),
  );
  let manifest: { layers?: { mediaType?: string; digest?: string; size?: number }[] };
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as typeof manifest;
  } catch {
    throw failed("STACK_MODEL_UNREADABLE", "its manifest is not JSON");
  }
  const layer = (kind: string) =>
    manifest.layers?.find((l) => l.mediaType === `application/vnd.ollama.image.${kind}`)?.digest;
  const model = layer("model");
  if (model === undefined || !/^sha256:[0-9a-f]{64}$/.test(model))
    throw failed("STACK_MODEL_UNREADABLE", "the manifest names no model file");
  const template = layer("template");
  const templateText =
    template === undefined || !/^sha256:[0-9a-f]{64}$/.test(template)
      ? ""
      : new TextDecoder().decode(
          await bounded(await get(`${base}/blobs/${template}`), TEMPLATE_BYTES, "template"),
        );
  // Only the head of the model file, also when the server answers the whole file instead of the range.
  const head =
    (await readAtMost(
      await get(`${base}/blobs/${model}`, { headers: { range: `bytes=0-${String(HEAD_BYTES - 1)}` } }),
      HEAD_BYTES,
      true,
    )) ?? new Uint8Array();
  const meta = readGgufMetadata(head);
  if (meta.contextLength === undefined)
    throw failed("STACK_MODEL_UNREADABLE", "its header states no context length");
  return {
    name: full,
    digest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    tools: /\.Tools\b/.test(templateText),
    vision: layer("projector") !== undefined || meta.vision,
    contextWindow: meta.contextLength,
    size: manifest.layers?.find((l) => l.digest === model)?.size ?? 0,
    kvBytesPerToken: meta.kvBytesPerToken,
  };
}
