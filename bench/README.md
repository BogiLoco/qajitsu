# Model benchmark (REQ-LLM-06)

`qajitsu bench --model <provider/model> [--role author]` runs the cases in
[`examples/demo-shop/.qa/bench.yaml`](../examples/demo-shop/.qa/bench.yaml) against the demo-shop built from its
worktree (`--build`) with real models. From the repository root: `pnpm bench --model local/gemma4:e2b`.

It reports, per model and role: detection rate (seeded bugs that ended FAILED), false FAILED (clean runs with a
FAILED test), BLOCKED rate, plan acceptance, duration, tokens and cost. Details:
[docs/guides/models-and-verification.md](../docs/guides/models-and-verification.md).

Rules:

- Never runs in PR CI (real models cost money and are non-deterministic). Nightly or on demand only; a contract
  test keeps it out of the workflows.
- Results are written to `examples/demo-shop/bench-results/<date>-<model>.json` (git-ignored).
- A model may score badly; it must never produce PASSED for a seeded bug. That would be a framework bug, not a
  model problem.

## Knowledge store at scale (REQ-KNOW-01/AC4)

`node bench/knowledge-scale.mjs --chunks 1000000 --dims 384` (after `pnpm build`) builds a LanceDB knowledge base of
synthetic chunks, lets the store build its full-text and IVF-PQ indexes, and measures search latency. Local only,
never in CI; CI runs a 60 000-chunk version of the same check in
`packages/adapters/knowledge-lancedb/src/lancedb-store.test.ts`.

Measured on 2026-10-06 (Apple M1 Pro, Node 22, `@lancedb/lancedb` 0.39.0):

| Chunks    | Load | Indexes | Keyword p95 | Hybrid p95 | Hybrid + tag p95 |
| --------- | ---- | ------- | ----------- | ---------- | ---------------- |
| 1 000 000 | 78 s | 27 s    | 17.8 ms     | 22.6 ms    | 80.2 ms          |
