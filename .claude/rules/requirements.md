# Requirements traceability

`docs/requirements/` is the source of truth for what QAJitsu must do. Format and lifecycle: `docs/requirements/README.md`.

- Before implementing, find the requirement(s) and acceptance criteria the work covers: `REQ-<AREA>-NN`, criteria `REQ-X-NN/ACk`.
  Area files: context (CTX), plan (PLAN), environment (ENV), config-secrets (CFG), workspace (WS), execution (EXEC),
  verification (VER), evidence (EVD), publishing (PUB), models (LLM), observability (OBS), ci-cd (CI), generic (GEN), non-functional (NFR).
- Work that no requirement covers, or that contradicts one: stop and propose a requirement change with `/requirement` first. Do not silently build beyond or against the catalogue.
- Tests are titled with the criterion id: `it("REQ-VER-03/AC1: denies agent writes to results/", ...)`.
- Commits carry `Refs: REQ-...` in the footer; PRs list the ids in the "Requirements" section.
- Tick a criterion (`[x]`) only when it is implemented **and** covered by a test. All ticked → `Status: implemented`; some → `in-progress`.
- Never renumber, reuse or delete an id. Removing means `Status: deprecated` with the reason or `Replaced by REQ-...`.
- After editing any requirement file run `pnpm req:index` and `pnpm req:check` (the Stop hook also runs the check).
- `docs/plan.md` (Polish) is background only; when it disagrees with the catalogue, the catalogue wins.
- The roadmap stage of a requirement (`Stage:`) decides when it is built; do not pull later-stage scope into current work without saying so.
