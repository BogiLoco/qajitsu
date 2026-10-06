// Scale benchmark of the default knowledge store (REQ-KNOW-01/AC4): builds a LanceDB knowledge base of synthetic
// chunks with indexes and measures keyword and hybrid search latency. Local only, never in CI:
//   pnpm build && node bench/knowledge-scale.mjs --chunks 1000000 --dims 384
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createLanceDbStore } from "../packages/adapters/knowledge-lancedb/dist/index.js";

const { values } = parseArgs({
  options: {
    chunks: { type: "string", default: "1000000" },
    dims: { type: "string", default: "384" },
    queries: { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
  },
});
const total = Number(values.chunks);
const dims = Number(values.dims);
const WORDS = Array.from({ length: 5000 }, (_, i) => `term${i.toString(36)}`);
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const sentence = (n) =>
  Array.from({ length: n }, () => WORDS[Math.floor(rand() ** 2 * WORDS.length)]).join(" ");
const vector = () => {
  const v = Array.from({ length: dims }, () => rand() - 0.5);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

const dir = await mkdtemp(join(tmpdir(), "qj-knowledge-scale-"));
const store = await createLanceDbStore(dir);
const started = Date.now();
const BATCH = 10_000;
for (let i = 0; i < total; i += BATCH) {
  const batch = [];
  for (let j = i; j < Math.min(total, i + BATCH); j++)
    batch.push({
      id: `${(j >> 4).toString(16).padStart(16, "0")}-${j & 15}`,
      source: "docs",
      path: `docs/file-${j >> 4}.md`,
      section: `Section ${j % 50}`,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      fileHash: "f",
      hash: `h${j}`,
      tags: j % 3 === 0 ? ["api"] : [],
      text: sentence(120),
      vector: vector(),
    });
  await store.upsert(batch);
  if ((i / BATCH) % 10 === 0) process.stdout.write(`  ${i + batch.length} chunks…\n`);
}
const loaded = Date.now();
await store.optimize(50_000);
const indexed = Date.now();

const measure = async (label, run) => {
  const times = [];
  for (let q = 0; q < Number(values.queries); q++) {
    const t = performance.now();
    await run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p = (x) => times[Math.min(times.length - 1, Math.floor(x * times.length))].toFixed(1);
  console.log(`${label}: p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${times.at(-1).toFixed(1)} ms`);
  return times.at(Math.floor(0.95 * times.length)) ?? Infinity;
};
console.log(
  `\n${total} chunks, ${dims} dims: load ${((loaded - started) / 1000).toFixed(0)} s, indexes ${((indexed - loaded) / 1000).toFixed(0)} s`,
);
const kw = await measure("keyword", () => store.search({ text: sentence(4), limit: 8 }));
const hy = await measure("hybrid ", () => store.search({ text: sentence(4), vector: vector(), limit: 8 }));
const tagged = await measure("hybrid + tag", () =>
  store.search({ text: sentence(4), vector: vector(), tags: ["api"], limit: 8 }),
);
await store.close();
if (!values.keep) await rm(dir, { recursive: true, force: true });
const ok = Math.max(kw, hy, tagged) < 1000;
console.log(ok ? "OK: p95 under one second (REQ-KNOW-01/AC4)" : "SLOW: p95 over one second");
process.exitCode = ok ? 0 : 1;
