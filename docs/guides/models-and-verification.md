# Models, the auditor, the canary and the benchmark (stage 7)

QAJitsu lets models plan and write tests, but never decide results. This page explains how to choose
models per role, what the extra verification checks do, and how to measure a model with `qajitsu bench`.

## Choosing models per role

```yaml
models:
  providers:
    company:
      { type: openai-compatible, base_url: https://litellm.example.com/v1, api_key: secret://env/LITELLM_KEY }
    local:
      type: ollama
      base_url: http://localhost:11434
      models:
        gemma4:e2b: { tools: true, structured_output: true, vision: true, context_window: 65536 }
  roles:
    default: company/strong # analyst, planner, author, healer
    summary: local/gemma4:e2b # short summaries and classification
    # auditor: unset → the first declared model that is not the author's (REQ-VER-06/AC3)
```

Thinking models in Ollama (Qwen3, DeepSeek-R1) behave differently with and without their thinking phase; Qwen3, for
example, calls tools only when thinking is set explicitly. `think: true` (or `false`) on the model passes the setting to
Ollama; without it Ollama's default applies:

```yaml
qwen3:14b: { tools: true, structured_output: true, vision: false, context_window: 65536, think: true }
```

A local model answers only when its whole reply is ready. QAJitsu waits up to `timeout_s` per request for `ollama`
and `openai-compatible` providers (default 1800 seconds) instead of the HTTP client's usual 5 minutes, so a thinking
model that first loads into memory is not cut off; set it lower to fail faster:

```yaml
local: { type: ollama, base_url: http://localhost:11434, timeout_s: 900 }
```

`qajitsu doctor --models` probes every role and lists missing capabilities. A role refuses a model without a
capability it needs (tools, structured output, vision for the auditor, context window).

## Cloud providers: what is verified (REQ-LLM-01)

The Anthropic path is checked against the published Claude Messages API documentation, without a key or network
(`tests/contract/anthropic-api.test.ts`, `tests/support/anthropic-api.ts`). A stand-in answers like the API and
refuses every request the documentation does not allow, so the tests prove that QAJitsu:

- calls `POST /v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`, and always `model`, `max_tokens`
  and `messages`;
- never prefills an assistant message and never forces tool use (`tool_choice` `any`/`tool`), which current Claude
  models reject; a second attempt at valid JSON uses structured outputs (`output_config.format`, JSON Schema);
- answers a `tool_use` with a `tool_result` for the same id, and counts the tokens of every step;
- retries the documented `429 rate_limit_error` and `529 overloaded_error`, and stops at once on
  `401 authentication_error` without the key in the error;
- runs the whole flow (fetch, analyst and planner, approve, run on the demo shop) with the key only in `.env.local`
  and nowhere in the journal, logs or `run.json`.

What this cannot prove is how a real Claude model plans: the answers are scripted. A run with a real key was done on
2026-10-18 (REQ-LLM-01/AC4). OpenAI and Google are built through the same AI SDK and covered by the registry tests,
not yet by a contract like this one.

## Prices and the spending limit (REQ-LLM-09)

Claude, OpenAI and Gemini models have built-in profiles: context window and price per million input and output
tokens, taken from the providers' pricing and models pages on the date in `BUILT_IN_PROFILES_CHECKED`
(`packages/models/src/capabilities.ts`). A price that depends on the prompt size uses its higher tier, so a limit errs
on the safe side. Prices announced to change have an end date: Gemini 4 Argon and Gemini 3.6/3.8 Flash cost what is
built in through 2026-12-31, and after that their cost is unknown until the new price is built in or declared. Where a
provider does not state a model's context window, the profile assumes a conservative 128k. Local models through Ollama
cost nothing. Any other model has no built-in price: declare it in the project config, which also wins over a
built-in value:

```yaml
models:
  providers:
    gateway:
      {
        type: openai-compatible,
        base_url: https://llm.example.com/v1,
        api_key: secret://env/GATEWAY_KEY,
        models:
          {
            my-model:
              {
                tools: true,
                structured_output: true,
                vision: false,
                context_window: 128000,
                cost_per_mtok: { input: 1, output: 4 },
              },
          },
      }
```

The run's cost adds up over its stages (plan, author, auditor, hints, exploration) in `run.json` (`costUsd`); a run
with a call of a model without a price is marked `costUnknown` and estimates say "cost unknown", never $0.
`budget.max_cost_usd` stops a model stage once the run's cost reaches it (`COST_BUDGET_EXCEEDED`, BLOCKED, exit code 2) and makes the cases not written yet NOT_RUN. `qj doctor --models` makes one call per role and names a rejected
key by its variable, never by its value.

### Cache prices, dated prices and cost per verified ticket (REQ-LLM-11)

Every model call records its input tokens, the input tokens read from or written to the provider's prompt cache,
output tokens, duration and cost, per role (`model.usage` in the journal). Cache reads and writes are charged with
their own price when one is set, and as input otherwise, so a cost is never lower than it may be. A price can carry
the day it applies from; a call is charged with the price valid on its day:

```yaml
models:
  providers:
    claude:
      type: anthropic
      models:
        claude-opus-5-5:
          cost_per_mtok: { input: 5, output: 25, cached_input: 0.5, cache_write: 6.25 }
          prices:
            - { from: "2026-12-01", input: 4, output: 20, cached_input: 0.4 }
```

`qj status` and `qj metrics` show what the project's runs cost: the cost per verified ticket (every run's cost,
also of runs that decided nothing, over the tickets with a GO or NO-GO decision), the cost per role, runner minutes per
ticket, the share of pipeline stages that needed no model, and the cost per verified ticket by ISO week as a trend.
When some call had no known price the cost is shown as a lower bound ("at least"), never as an exact number.

### Prompt caching and input limits (REQ-LLM-12)

Agents send their instructions and the ticket and repository context first, the same for every repair of an answer
and every case of a stage, so providers can cache that prefix. Anthropic needs an explicit cache breakpoint, which
QAJitsu sets on the instructions and the context message; OpenAI and Google cache a stable prefix by themselves. Cache
reads show up as `cachedInputTokens` in the journal and are charged at the cache price (REQ-LLM-11).
`models.cache_ttl` sets the cache duration: `auto` (default) chooses five minutes when the project's model calls
usually come within five minutes of each other and one hour when within an hour (the longer cache costs more to
write), `5m`, `1h`, or `off`. The choice and its reason are recorded in `run.json` (`promptCache`).

Before every call QAJitsu estimates its input (one token per four characters, a fixed amount per image) and stops a
call that would exceed the model's context window, its price tier boundary (Gemini Pro charges more above 200k
tokens; `price_tier_tokens` sets it for any model) or `models.max_input_tokens`, with the estimate and the limit
(`MODEL_INPUT_TOO_LARGE`); nothing is sent.

## Local models, honestly (REQ-LLM-05)

Local models are good at the roles that read and classify: **summary**, **analyst** on small changes and
the **auditor** as a second opinion. They are usually weak at the roles that write: the **planner** on
large tickets, the **author** (TypeScript against the steps API) and the **healer**. With a small model,
expect:

- more plans rejected by the source checks (the planner cites things that are not in the ticket or diff);
- more cases **BLOCKED** because the author could not produce a spec that passes the static checks;
- more healing attempts that end without a valid spec.

What a weak model can never do is produce a false **PASSED**. The trusted parent records every response
itself and compares it with the approved plan (ADR-0004), every planned expectation needs its own `verify()`
(a spec that leaves one out is blocked and, if it ran, would end NEEDS_REVIEW), healed passes are
NEEDS_REVIEW, and the auditor and the canary can only downgrade. `tests/adversarial/weak-model.test.ts`
proves this with an author that writes nothing, one that hard-codes the expected value and one that skips
the check of the buggy field.

A practical split: a cloud or LiteLLM model for `planner` and `author`, a local model for `summary` and as
`auditor`. Measure before you decide (`qajitsu bench` below).

## The test code quality gate (REQ-VER-23)

An agent can write a bad test, like a person. Before a generated spec runs, code checks it for assertions that cannot
fail or can be skipped; a finding sends the spec back to the author once with the finding, then the case is BLOCKED
with it, never PASSED. The findings are in the case's record and in the report.

| Rule               | What it stops                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `constant-actual`  | a constant, a planned value (`plan.expect(...)`) or `x === x` passed as the actual value                           |
| `skippable-verify` | a `verify()` inside an `if`, `?:`, `&&`/`\|\|`/`??`, `switch`, loop, `try`/`catch` block, callback or `?.()`       |
| `early-return`     | a `return` before a `verify()` of the same step or of a later step                                                 |
| `swallowed-error`  | an empty `catch {}` or `.catch(() => {})` anywhere in the spec                                                     |
| `disabled-case`    | `.skip`, `.fixme`, `.only`, `.todo`, `xit`, `xdescribe`                                                            |
| `general-target`   | an element check on the whole page (`css:body`, `css:html`, `role:main`, ...) or a planned text under 3 characters |

The runtime never takes the actual value from the spec: it reads the response or the live page itself and the
expected value from the frozen plan, so even a spec that slipped through would fail on a bug. The gate exists so bad
test code is visible and fixed, not run. What it cannot see is a test that is correct but checks too little, for
example only the status and not the amount: the plan's expectations decide that, so review them before you approve.

## The auditor (REQ-VER-06)

After the runner, a separate agent with fresh context reviews every **PASSED** case: the approved plan,
the raw results, text evidence and up to `verification.auditor_max_images` screenshots. It answers one
finding per case; `weak: true` moves that case to **NEEDS_REVIEW** with the reason in the report. The
orchestrator writes `checks/audit.json` from the validated answer; agents cannot write `checks/`.

```yaml
verification:
  auditor: optional # optional (failure = warning) | required (failure = every PASSED → NEEDS_REVIEW) | off
  auditor_max_images: 12
```

Without `models.roles.auditor`, the auditor takes the first declared model other than the author's, but only
from providers some role already uses, so evidence never goes to a provider nobody assigned. If it has to share the
author's model, the report says so.

Check records fail closed: `checks/audit.json` and `checks/canary.json` are hashed into `run.json` when written.
When a check is enabled and something PASSED, a missing, changed or unreadable record turns every PASSED into
NEEDS_REVIEW and fails the `checks-intact` publish gate. Deleting a record never brings back a PASSED it took away.

## Failure hints (REQ-VER-12)

After a run with FAILED cases, the `triage` role (`models.roles.triage`, else `default`) suggests a likely cause
for each one: `product-bug`, `test-bug`, `environment` or `data`, with a short justification. It sees the approved
plan, the runner record, text evidence and the tails of the run's log files, and must cite what it relies on: a step
(`S1`), an assertion (`S1.fields.total`), an evidence file or a log file. Code keeps only citations that exist for
that case and drops a hint with none left; an invalid answer leaves the case without a hint.

Hints are suggestions: they never change a status or a count. They appear as a separate column in the matrix, under
the status in the report and in their own section of the Jira comment. `checks/triage.json` is hashed into
`run.json` like the other check records, so an edited hint fails the `checks-intact` gate.

After a run with BLOCKED cases the same role explains each one (REQ-VER-13): `spec` (the generated test is wrong),
`plan` (an expectation names something the application does not show), `environment`, `tooling` (browser, device,
Appium) or `configuration`, with one concrete next step. It sees the plan, the runner record with the error, the spec
with line numbers, text evidence such as the page source, and log tails, and cites the `error`, spec lines, steps,
evidence or logs. Code keeps only citations that exist. The hints are printed under the result table of `qj run`,
appear in the matrix and report, and are kept in `checks/blocked.json`, hashed like the other records; they never
change a status.

```yaml
verification:
  triage: on # off: no model calls for FAILED or BLOCKED cases
```

## The canary (REQ-VER-09)

```yaml
verification:
  canary: true
```

The first case that PASSED runs once more with one expectation inverted in a copy of the plan (a status
of 418, a field value that cannot occur, a text that is not on the page). A working test must fail it. If it
passes, or the canary could not run, every PASSED of the run becomes NEEDS_REVIEW: the tests in this run could not
tell good from bad. With nothing to invert it is recorded as skipped.
The canary's evidence stays in `checks/canary/`, outside the manifest and the published results.

## Benchmarking a model (REQ-LLM-06)

```sh
cd examples/demo-shop
export DEMO_USER_PASSWORD=<any value>
qj bench --model local/gemma4:e2b                 # every role
qj bench --model company/strong --role author     # only the author
```

Cases come from `.qa/bench.yaml` (demo-shop: four seeded bugs and one clean run). Each case is a fresh run:
fetch, plan, approve without review, `run --build --set api.<FLAG>=1`. The report (Markdown in the terminal,
JSON in `bench-results/<date>-<model>.json`) lists per case the plan acceptance and statuses, and in total:

| Metric          | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| detection       | bug cases where at least one test ended FAILED                    |
| false FAILED    | clean cases with a FAILED test                                    |
| BLOCKED         | BLOCKED tests over all tests                                      |
| plan acceptance | cases whose plan passed the checks and was approved without edits |
| time, tokens    | wall time and model tokens; cost when `cost_per_mtok` is declared |

Benchmark runs are marked `bench` in `run.json`, approved as `bench:<user>` (not as a person) and refused by
`qajitsu publish`. The benchmark makes real model calls: it never runs in PR CI (a contract test checks the workflows); run it
nightly or on demand.

## Agent scorecard and plan quality (REQ-LLM-14, REQ-PLAN-16)

How well each agent does its job is measured by code from what every run records (`journal/agents.jsonl`, the
journal, gates and reviews), never by asking a model. `qj status` and `qj metrics` show, per role and model: calls,
cost, latency (p50, p95), the share of agent steps that needed no repair of invalid output, and tool calls the guard
denied; the author's share of specs right on the first try and what the checks and the quality gate rejected, by
rule; review send-backs; the planner's flagged expectations and coverage gaps per plan; the healer's accepted heals.

Plan and test quality per project: plans approved without changes, revision rounds, tickets the readiness gate
stopped, FAILED cases a person found to be no product bug, PASSED cases the auditor downgraded, and defects that
escaped. The last two need a person's word, recorded after the run, which never changes a status:

```sh
qj feedback SHOP-482 --case TC-03 --is test-bug --note "the plan expected the old rounding"
qj feedback SHOP-482 --escaped SHOP-512        # a defect found later on a ticket the run passed
```

`qj bench` adds the scorecard to its report, with the demo shop's ground truth (the seeded bug was found, the plan
has a case for the criterion the bug breaks, `criterion` in `.qa/bench.yaml`), and compares it with the previous
report of the same model. Answers of real models recorded in `journal/agents.jsonl` can be replayed as scripted models
in tests (`tests/support/replay.ts`): `tests/golden/replay-gemma.test.ts` plays gemma4:e2b's analysis and plan for
DEMO-1, invalid answers included, through today's parsers and checks.
