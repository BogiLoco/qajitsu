# `qajitsu run`

Roadmap stage 3. Executes the **approved** plan of a run against a provided environment and writes results,
evidence and reports. Statuses are computed by code from runner output only (invariant 1).

```text
qajitsu run <TICKET> [--run <id>] [--env <profile|url>]
```

## What happens

1. The approved plan is loaded and its SHA-256 checked against `run.json`; a mismatch stops the run (REQ-PLAN-06).
2. Environment: `--env <profile>` reads `.qa/envs/<profile>.yaml`; `--env <url>` uses the default profile with that
   URL; without `--env`, `environments.default` is used, otherwise a terminal asks and CI fails (REQ-ENV-07).
   The origin must be in `environments.allowlist`; profiles marked `production: true` are denied unless
   `environments.allow_production` is set (REQ-ENV-01, invariant 10).
3. Health check: an unhealthy environment makes every case **BLOCKED** (REQ-ENV-01/AC1).
4. Deployed version: the profile's `version_path` is compared with the analysed SHAs. Mismatch: a terminal asks;
   CI warns or fails per `environments.on_version_mismatch` (REQ-ENV-02). The deployed SHA goes into `run.json` and the report.
5. Specs: the **author** agent writes `specs/TC-xx.spec.ts` for cases without one (REQ-EXEC-01). Every spec, also
   hand-written ones, passes static checks first (REQ-EXEC-03): only `import type` from `@qajitsu/steps`, no
   `process`/`fetch`/`eval`/dynamic import, one `step()` per plan step, at least one `verify()` per step, every
   expected value is `plan.expect("<case>.<step>.<field>")` (assertion lock), and `tsc`. Two failed attempts → BLOCKED.
   Only `specs/TC-xx.spec.ts` of approved cases run; anything else is reported (REQ-PLAN-06/AC4).
6. Execution: each attempt runs in a **sandboxed Node process** (permission model: read-only access to the spec folder
   and installed packages, no file writes, no child processes, no secrets in the environment). The parent logs in
   every account alias for each attempt (REQ-CFG-07) and is the only writer of `results/` and `evidence/`
   (invariant 2). One retry by default (`environments.retries`); success only on a retry is FLAKY (REQ-EXEC-08).
7. Verdict: `computeStatus` per case, evidence manifest re-hashed, publish gates (every approved case has one status,
   plan unchanged, PASSED is proven, FAILED is explained, manifest intact, no secrets in outgoing artifacts).
8. Reports in `report/`: `matrix.md`, `matrix.csv`, `matrix.xlsx`, `report.html` (self-contained), `gates.json`.

## Spec format

```ts
import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  await step("S1", async () => {
    const res = await api.as("user:standard").get("/cart");
    verify("S1", "status", res.status, plan.expect("TC-01.S1.status"));
    verify("S1", "fields.total", res.json("total"), plan.expect("TC-01.S1.fields.total"));
  });
}
```

Each API call becomes `evidence/<case>/attempt-<n>/<step>-<nn>.json` (method, URL, masked headers and bodies,
status, duration, assertions with expected and actual, a masked cURL) listed in `evidence/manifest.json` with SHA-256.

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Every case PASSED and every gate passed                                    |
| 1    | At least one case FAILED                                                   |
| 2    | No failures, but BLOCKED, FLAKY, NOT_RUN or NEEDS_REVIEW, or a gate failed |
| 3    | Configuration or framework error (plan hash, environment, version abort)   |
