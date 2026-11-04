# `qajitsu run`

Roadmap stage 3. Executes the **approved** plan of a run against a provided environment and writes results,
evidence and reports. Statuses are computed by code from runner output only (invariant 1).

```text
qajitsu run <TICKET> [--run <id>] [--env <profile|url>] [--keep] [--env-not-confirmed "<reason>"]
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
   4a. Environment readiness for the ticket (REQ-ENV-13), when `environments.readiness` is configured: every repository
   of the change must be deployed (its deployed commit, read from a JSON endpoint or a script, is the change or
   contains it), and every configured check must hold (health, migrations, feature flags for the ticket's labels,
   account logins, scripts). The report goes to `run.json` (`readiness_env`), `report.html`, the certificate and, per
   `readiness.comment`, a ticket comment. Not ready: every case is **BLOCKED** with the failed checks and their
   observed values; with `readiness.wait` it is checked again until the deployment arrives or the time is up.
   `--env-not-confirmed "<reason>"` runs anyway: the reason and the person are recorded, every report says
   "environment not confirmed" and `qj release` never counts the run as verified.
5. Specs: the **author** agent writes `specs/TC-xx.spec.ts` for cases without one (REQ-EXEC-01). Every spec, also
   hand-written ones, passes static checks first (REQ-EXEC-03): only `import type` from `@qajitsu/steps`, no
   `process`/`fetch`/`eval`/dynamic import, one `step()` per plan step, at least one `verify()` per step, every
   expected value is `plan.expect("<case>.<step>.<field>")` (assertion lock), and `tsc`. Two failed attempts → BLOCKED.
   Only `specs/TC-xx.spec.ts` of approved cases run; anything else is reported (REQ-PLAN-06/AC4).
6. Execution: each attempt runs in a **sandboxed Node process** (permission model: read-only access to the spec folder
   and installed packages, no file writes, no child processes, no secrets in the environment). The parent logs in
   every account alias for each attempt (REQ-CFG-07) and is the only writer of `results/` and `evidence/`
   (invariant 2). One retry by default (`environments.retries`); success only on a retry is FLAKY (REQ-EXEC-08).
   Before each attempt the case's `test_data` is created through the application's API or the data hook, marked
   `qj-<ticket>-<run>-<case>-a<attempt>`, and removed after it (`--keep` leaves it); data that cannot be created
   makes the attempt BLOCKED before any step (REQ-EXEC-53). A step with a planned `wait` repeats its actions and
   checks until they hold or the time is up (REQ-EXEC-46).
   On a shared environment (REQ-EXEC-54), every request of every lane keeps to `execution.rate_limit`, which sets the
   requests per second to one host and the cases at once across lanes:
   - A `429` or `503` with `Retry-After` is waited out and retried, only for a request that is safe to repeat: a
     `GET`, or a request of a step with `idempotency_key: true`. A timeout of a keyed request is retried too. Each
     retry is recorded in the call's evidence.
   - A request that is not safe to repeat is never sent twice.
   - A case still rate limited after `retry_budget_s` (30 s by default) is BLOCKED with "rate limited", never FAILED
     or PASSED. A step whose plan expects that status gets the response as it came.
   - A keyed request carries `Idempotency-Key: qj-<case>-<step>-a<attempt>-<n>`, the same on every retry.
     GraphQL (REQ-EXEC-48): a spec calls `api.graphql(query, variables)` (`POST /graphql`, or another `path`). After the
     attempt, code checks every such call against the schema of the analysed commit. That schema is
     `repos.<alias>.graphql`: an SDL file in the repository, or an endpoint path like `/graphql`, which is introspected on
     the environment.
   - A query that cannot be parsed, does not fit the schema or skips the plan step's `graphql.operation` is the spec's
     error: BLOCKED.
   - An `errors` array where the plan expects data fails the step, even with HTTP 200.
   - Data that does not fit the schema's types fails it too.
   - Expectations read the answer by path, like JSON: `fields.data.product.price`, `fields.errors.0.message`.
   - A subscription is `api.subscribe(query, variables)`: a WebSocket to `/graphql` (or `path`) speaking
     graphql-transport-ws. Every pushed payload is a message (`messages.0.data.priceChanged.price`), checked like a
     stream's, and the query and each payload are checked against the schema like a query's.
   - A step planned as GraphQL that sends its query any other way (`api.post`) is the spec's error: BLOCKED.

     WebSocket and server-sent events (REQ-EXEC-47): a spec opens `api.websocket(path)` (then `send()`) or
     `api.events(path)`. The trusted process opens the stream with the account's headers, only to an origin of the
     allowlist (`ws:`/`wss:` count as `http:`/`https:`), and keeps every frame sent and received, masked, as
     `S1-websocket-01.json` or `S1-events-01.json`. `verify(step, "messages.<n>.<path>")` waits for message `n` up to
     the step's `stream.timeout_s` (10 s by default), and `messages.count` counts the messages until the stream ends or
     the time is up.

   - A planned message that does not come fails the step, with the close code and reason when the stream ended first
     (`(no message 1 within 3 s (the stream closed with 1011 price feed down))`).
   - A stream that cannot be opened, or one to another host, is the step's error: BLOCKED with the reason.

     SOAP and XML (REQ-EXEC-50): a spec calls `api.soap(path, bodyXml, { action, version })`. The body element is
     wrapped in a SOAP 1.1 envelope (`text/xml`, `SOAPAction`) or a 1.2 one (`application/soap+xml; action=...`). A
     plain XML request is `api.text(xml, "application/xml")`. `await res.xml("//GetPriceResponse/amount")` reads an
     XPath over local names, and `verify(step, "xml.<xpath>", ...)` reads that value from the response itself, as the
     plan's type. After the attempt, code checks every call against `repos.<alias>.wsdl` (the schemas in its `types`)
     and `repos.<alias>.xsd` of the analysed commit:

   - A fault where the plan expects an answer fails the step, even with HTTP 200. A step expects a fault when it plans
     status 500 or an XPath on `Fault`.
   - An answer, SOAP body or plain XML, that does not fit the schemas fails it too (`soap.schema`).
   - A request that sends neither the plan step's `soap.operation` nor names it in its action, or a SOAP step that
     makes no `api.soap()` call, is the spec's error: BLOCKED.
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

Bodies other than JSON (REQ-EXEC-45) are made by the client; files are keys of the case's `files` in the plan:

```ts
const user = api.as("user:standard");
await user.post("/documents", user.multipart({ fields: { title: "Invoice 7" }, files: { file: "invoice" } }));
await user.post("/login", user.form({ user: "anna" }));
await user.put("/documents/1/raw", user.binary("invoice"));
await user.post("/notes", user.text("id,name\n1,Lamp", "text/csv"));
// A response that is a file is checked like a download in the same step.
const pdf = await user.get(`/documents/${id}/file`);
verify("S2", "download.size", undefined, plan.expect("TC-01.S2.download.size"));
// Records of the plan's test_data, created for this attempt.
const lamp = data.get("lamp");
```

Each API call becomes `evidence/<case>/attempt-<n>/<step>-<nn>.json` (method, URL, masked headers and bodies,
status, duration, assertions with expected and actual, a masked cURL) listed in `evidence/manifest.json` with SHA-256.
A file response is kept as its own evidence file (`<step>-download-<name>`) and the call record points to it with its
SHA-256; a waiting step adds `<step>-wait.json` with every round; test data adds `test-data.json` (masked).

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Every case PASSED and every gate passed                                    |
| 1    | At least one case FAILED                                                   |
| 2    | No failures, but BLOCKED, FLAKY, NOT_RUN or NEEDS_REVIEW, or a gate failed |
| 3    | Configuration or framework error (plan hash, environment, version abort)   |
