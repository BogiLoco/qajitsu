import { createHash } from "node:crypto";
import type { Embedder } from "@qajitsu/core";

/**
 * A deterministic embedder for tests: a normalized bag of hashed words in `dimensions` buckets, so texts that share
 * words are close. Records every batch it embedded.
 */
export function createFakeEmbedder(
  options: { id?: string; local?: boolean; dimensions?: number } = {},
): Embedder & {
  readonly calls: string[][];
} {
  const dimensions = options.dimensions ?? 64;
  const calls: string[][] = [];
  const vector = (text: string): number[] => {
    const v = new Array<number>(dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
      const bucket = createHash("sha1").update(word).digest().readUInt32BE(0) % dimensions;
      v[bucket] = (v[bucket] ?? 0) + 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    id: options.id ?? "fake/embed",
    local: options.local ?? true,
    calls,
    embed: (texts) => {
      calls.push([...texts]);
      return Promise.resolve(texts.map(vector));
    },
  };
}
