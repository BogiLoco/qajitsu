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
