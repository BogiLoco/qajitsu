# Model benchmark (REQ-LLM-06, stage 7)

`qajitsu bench --model <provider/model> [--role author]` runs the cases in [`cases.yaml`](cases.yaml) against
`examples/demo-shop` with real models and reports, per model and role:

- detection rate: seeded bugs that ended FAILED
- false FAILED: cases that failed with every bug flag off
- BLOCKED rate, plan acceptance without edits, duration, tokens and cost

Rules:

- Never runs in PR CI (real models cost money and are non-deterministic). Nightly or on demand only.
- Results are written to `bench/results/<date>-<model>.json` (git-ignored) and summarized in the release notes.
- A model may score badly; it must never produce PASSED for a seeded bug. That would be a framework bug, not a model problem.
