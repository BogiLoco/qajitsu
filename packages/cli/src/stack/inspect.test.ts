import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeFetch, type Route } from "../../../../tests/support/fake-fetch.js";
import { inspectModel, memoryEstimate, readGgufMetadata } from "./inspect.js";

/** A GGUF v3 header with the given metadata (strings, u32 and string arrays), no tensors. */
function gguf(entries: [string, string | number | string[]][]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("GGUF")];
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
  parts.push(u32(3), u64(0), u64(entries.length));
  for (const [key, value] of entries) {
    parts.push(str(key));
    if (typeof value === "string") parts.push(u32(8), str(value));
    else if (typeof value === "number") parts.push(u32(4), u32(value));
    else parts.push(u32(9), u32(8), u64(value.length), ...value.map(str));
  }
  return new Uint8Array(Buffer.concat(parts));
}

const digestOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** The registry of one model: manifest, template, optional projector, and the model blob's first bytes. */
function registry(
  name: string,
  tag: string,
  model: Uint8Array,
  template: string,
  projector = false,
): Route[] {
  const t = digestOf(template);
  const m = `sha256:${"9".repeat(64)}`;
  const manifest = JSON.stringify({
    schemaVersion: 2,
    layers: [
      { mediaType: "application/vnd.ollama.image.model", digest: m, size: 2_500_000_000 },
      { mediaType: "application/vnd.ollama.image.template", digest: t, size: template.length },
      ...(projector ? [{ mediaType: "application/vnd.ollama.image.projector", digest: m, size: 1 }] : []),
    ],
  });
  return [
    { match: new RegExp(`^/v2/library/${name}/manifests/${tag}$`), reply: () => new Response(manifest) },
    { match: new RegExp(`^/v2/library/${name}/blobs/${t}$`), reply: () => new Response(template) },
    {
      match: new RegExp(`^/v2/library/${name}/blobs/${m}$`),
      reply: (r) => {
        // Only the head of the model is asked for, never the whole file.
        expect(r.headers["range"]).toMatch(/^bytes=0-\d+$/);
        return new Response(model, { status: 206 });
      },
    },
  ];
}

describe("what a model can do, from the Ollama registry (REQ-GEN-10/AC3)", () => {
  it("REQ-GEN-10/AC3: reads the context length and the architecture from the model's GGUF header", () => {
    const meta = readGgufMetadata(
      gguf([
        ["general.architecture", "qwen3"],
        ["qwen3.context_length", 262_144],
        ["tokenizer.ggml.tokens", ["a", "b", "c"]],
      ]),
    );
    expect(meta).toEqual({
      architecture: "qwen3",
      contextLength: 262_144,
      vision: false,
      kvBytesPerToken: undefined,
    });
    // qwen3:4b's attention shape: 36 layers, 8 key/value heads of 128. At 131072 tokens in f16 that is the 18432 MiB
    // Ollama tried to allocate in the lab; q8_0 needs about half.
    const shaped = readGgufMetadata(
      gguf([
        ["general.architecture", "qwen3"],
        ["qwen3.context_length", 262_144],
        ["qwen3.block_count", 36],
        ["qwen3.attention.head_count", 32],
        ["qwen3.attention.head_count_kv", 8],
        ["qwen3.attention.key_length", 128],
        ["qwen3.attention.value_length", 128],
      ]),
    );
    expect(shaped.kvBytesPerToken).toBe(147_456);
    expect(((shaped.kvBytesPerToken ?? 0) * 131_072) / 2 ** 20).toBe(18_432);
    const model = {
      name: "qwen3:4b",
      digest: "",
      tools: true,
      vision: false,
      contextWindow: 262_144,
      size: 2_500_000_000,
      kvBytesPerToken: shaped.kvBytesPerToken,
    };
    expect(Math.round((memoryEstimate(model, 131_072) ?? 0) / 1e9)).toBe(13);
    expect(memoryEstimate({ ...model, kvBytesPerToken: undefined }, 131_072)).toBeUndefined();
    const vision = readGgufMetadata(
      gguf([
        ["general.architecture", "mistral3"],
        ["mistral3.context_length", 131_072],
        ["mistral3.vision.block_count", 24],
      ]),
    );
    expect(vision.vision).toBe(true);
    // Not a GGUF file: nothing is guessed.
    expect(() => readGgufMetadata(new TextEncoder().encode("<html>"))).toThrow(/GGUF/);
  });

  it("REQ-GEN-10/AC3: tools come from the chat template, vision from a projector or the model's vision keys", async () => {
    const fake = createFakeFetch([
      ...registry(
        "qwen3",
        "4b",
        gguf([
          ["general.architecture", "qwen3"],
          ["qwen3.context_length", 262_144],
        ]),
        "{{- if .Tools }}tools{{ end }}",
      ),
      ...registry(
        "gemma3",
        "4b",
        gguf([
          ["general.architecture", "gemma3"],
          ["gemma3.context_length", 131_072],
        ]),
        "{{ .Prompt }}",
        true,
      ),
    ]);
    const qwen = await inspectModel("qwen3:4b", fake.fetch);
    expect(qwen).toMatchObject({ name: "qwen3:4b", tools: true, vision: false, contextWindow: 262_144 });
    // The digest is the SHA-256 of the manifest as the registry serves it: what Ollama lists once it is pulled.
    const manifest = await (
      await fake.fetch("https://registry.ollama.ai/v2/library/qwen3/manifests/4b")
    ).text();
    expect(qwen.digest).toBe(digestOf(manifest));
    expect(await inspectModel("gemma3:4b", fake.fetch)).toMatchObject({
      tools: false,
      vision: true,
      contextWindow: 131_072,
    });
  });

  it("REQ-GEN-10/AC3: a header without a context length is an error, never a default", async () => {
    const fake = createFakeFetch(
      registry("odd", "1b", gguf([["general.architecture", "odd"]]), "{{ .Tools }}"),
    );
    await expect(inspectModel("odd:1b", fake.fetch)).rejects.toThrow(/odd:1b.*context length/);
  });

  it("REQ-GEN-10/AC3 + INV-8: a server that ignores Range or sends a huge manifest never fills memory; odd names are refused", async () => {
    const head = gguf([
      ["general.architecture", "qwen3"],
      ["qwen3.context_length", 262_144],
    ]);
    // The whole "model file" answered with 200: 64 MiB after the header, read only to the 8 MiB head.
    const whole = new Uint8Array(64 * 1024 * 1024);
    whole.set(head);
    let sent = 0;
    const routes = registry("big", "1b", whole, "{{ .Tools }}").map((r, i) =>
      i === 2
        ? {
            ...r,
            reply: () =>
              new Response(
                new ReadableStream({
                  pull(controller) {
                    if (sent >= whole.length) {
                      controller.close();
                      return;
                    }
                    controller.enqueue(whole.subarray(sent, sent + 1024 * 1024));
                    sent += 1024 * 1024;
                  },
                }),
              ),
          }
        : r,
    );
    expect(await inspectModel("big:1b", createFakeFetch(routes).fetch)).toMatchObject({
      contextWindow: 262_144,
    });
    // The stream reads a chunk or two ahead; the 64 MiB file is never read in full.
    expect(sent).toBeLessThanOrEqual(12 * 1024 * 1024);
    const huge = createFakeFetch([
      {
        match: /^\/v2\/library\/huge\/manifests\/1b$/,
        reply: () => new Response("x".repeat(2 * 1024 * 1024)),
      },
    ]);
    await expect(inspectModel("huge:1b", huge.fetch)).rejects.toThrow(/manifest is larger than/);
    for (const bad of ["../etc:1b", "a?b=c:1b", "UPPER:1b", "x/../y:1b"])
      await expect(inspectModel(bad, huge.fetch), bad).rejects.toThrow(/not an Ollama model name/);
  });
});
