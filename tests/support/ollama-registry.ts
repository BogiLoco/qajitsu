// A fake Ollama registry for `qajitsu stack` tests: manifests, chat templates and GGUF headers of fictional builds of
// real model names, with the capabilities each one is given.
import { createHash } from "node:crypto";
import type { Route } from "./fake-fetch.js";

/** What a fake model can do. */
export interface FakeModel {
  readonly tools: boolean;
  readonly vision: boolean;
  readonly context: number;
  /** Layers, key/value heads and their size, as the real model's header states them. */
  readonly attention?: { readonly blocks: number; readonly kvHeads: number; readonly headDim: number };
  /** Bytes of the model file. */
  readonly size?: number;
}

/** The capabilities the real models had in the registry on 2026-11-15. */
export const REAL_MODELS: Record<string, FakeModel> = {
  "qwen3:4b": {
    tools: true,
    vision: false,
    context: 262_144,
    attention: { blocks: 36, kvHeads: 8, headDim: 128 },
    size: 2_497_000_000,
  },
  "qwen3:8b": { tools: true, vision: false, context: 40_960 },
  "gpt-oss:20b": {
    tools: true,
    vision: false,
    context: 131_072,
    attention: { blocks: 24, kvHeads: 8, headDim: 64 },
    size: 13_780_000_000,
  },
  "mistral-small3.2:24b": {
    tools: true,
    vision: true,
    context: 131_072,
    attention: { blocks: 40, kvHeads: 8, headDim: 128 },
    size: 15_180_000_000,
  },
  "gemma3:4b": { tools: false, vision: true, context: 131_072 },
  "nomic-embed-text:latest": { tools: false, vision: false, context: 2_048 },
  "smollm2:135m": { tools: false, vision: false, context: 8_192 },
};

/** A GGUF v3 header with an architecture, its context length, its attention shape and, for vision, one vision key. */
export function ggufHeader(
  arch: string,
  context: number,
  vision = false,
  attention?: FakeModel["attention"],
): Uint8Array {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const entries: Buffer[] = [
    Buffer.concat([str("general.architecture"), u32(8), str(arch)]),
    Buffer.concat([str(`${arch}.context_length`), u32(4), u32(context)]),
    ...(vision ? [Buffer.concat([str(`${arch}.vision.block_count`), u32(4), u32(24)])] : []),
    ...(attention
      ? [
          Buffer.concat([str(`${arch}.block_count`), u32(4), u32(attention.blocks)]),
          Buffer.concat([str(`${arch}.attention.head_count_kv`), u32(4), u32(attention.kvHeads)]),
          Buffer.concat([str(`${arch}.attention.key_length`), u32(4), u32(attention.headDim)]),
          Buffer.concat([str(`${arch}.attention.value_length`), u32(4), u32(attention.headDim)]),
        ]
      : []),
  ];
  return new Uint8Array(
    Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length), ...entries]),
  );
}

const sha = (data: string | Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** The manifest digest the fake registry serves for a model: what Ollama would list once it is pulled. */
export const fakeModelDigest = (name: string): string => sha(manifestOf(name));

const blobs = (name: string) => {
  const model = REAL_MODELS[name];
  const template = model?.tools ? "{{- if .Tools }}tools{{ end }}{{ .Prompt }}" : "{{ .Prompt }}";
  const head = ggufHeader(
    name.split(":")[0]?.replace(/[^a-z0-9]/g, "") ?? "x",
    model?.context ?? 0,
    model?.vision,
    model?.attention,
  );
  return { template, head, model };
};
function manifestOf(name: string): string {
  const { template, head } = blobs(name);
  return JSON.stringify({
    schemaVersion: 2,
    layers: [
      {
        mediaType: "application/vnd.ollama.image.model",
        digest: sha(head),
        size: REAL_MODELS[name]?.size ?? head.length,
      },
      { mediaType: "application/vnd.ollama.image.template", digest: sha(template), size: template.length },
    ],
  });
}

/** Routes of the fake registry for every model of {@link REAL_MODELS}; another name is not found. */
export function ollamaRegistryRoutes(): Route[] {
  return [
    {
      match: /^\/v2\/library\/[^/]+\/(manifests|blobs)\/[^/]+$/,
      reply: (r) => {
        const [, , , repo, kind, ref] = r.url.pathname.split("/");
        for (const name of Object.keys(REAL_MODELS)) {
          const [n, tag] = name.split(":");
          if (n !== repo) continue;
          const { template, head } = blobs(name);
          if (kind === "manifests" && ref === tag) return new Response(manifestOf(name));
          if (kind === "blobs" && ref === sha(template)) return new Response(template);
          if (kind === "blobs" && ref === sha(head)) return new Response(head, { status: 206 });
        }
        return new Response("not found", { status: 404 });
      },
    },
  ];
}
