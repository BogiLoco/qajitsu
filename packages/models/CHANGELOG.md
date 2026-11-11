# @qajitsu/models

## 0.1.0

### Minor Changes

- ae9a935: Start with an API key only (REQ-LLM-09): `qj init` finds provider keys by name and proposes Claude models with a
  spending limit; Claude models have built-in context windows and prices; the run's cost adds up over every stage, an
  unknown price shows as unknown, and `budget.max_cost_usd` stops model stages; `qj doctor --models` names a rejected
  key by its variable.
- a3ab148: Context budgets (REQ-LLM-15, REQ-CTX-12, REQ-CTX-14): every model has a context profile (working range below the
  window, answer reserve, token margin per family, provider counting for Anthropic, cache style, compact style for small
  windows and local models; `working_range` and `context_style` per model in `models.providers`). Calls that fit are
  sent as they are; otherwise the context manager reduces by code: on-demand material and what matches nothing of the
  task go behind handles, large diffs and logs are trimmed with their structure kept, then the least relevant fragments
  follow; pinned fragments are never touched and a call they alone overflow is refused. Agents read handles with
  `read_context` and find them with `search_context`; reads are journaled. Snapshots carry the budget, the catalogue and
  the relevance ranking; `qj logs` shows them in one line. Tool results are wrapped in the run's data blocks.
- 8384943: Context metrics and policies (REQ-CTX-18): `qj metrics` exports per role and model the estimated input tokens by
  fragment kind, reductions by action, assembled inputs, `read_context` and `search_context` calls and the prompt cache
  hit rate (`contextUsage` / `mergeContextUsage` in `@qajitsu/report`). `qj bench --context <policies>` runs every case
  once per context policy (`default`, `full`, `compact`, `range=<tokens>`, combined with `+`), reports detection, plan
  quality, tokens, cost and time per policy and names the cheapest policy that keeps the best quality. The model
  registry takes a `contextPolicy` that wins over every model's own working range and style.
- 4585559: Shares of the context budget per source (REQ-CTX-14/AC1): `models.context_shares` (e.g. `{ diff: 0.5, knowledge: 0.2 }`,
  at most 1 together) reaches every model's context profile. Over the budget, a source kind over its share is reduced
  first, the furthest over first and only as far as the call needs, with the usual code reductions; shares a kind does
  not use go to the others, and a call that fits is sent whole. The shares that applied are recorded in the snapshot.
- 693612b: Every explorer (browser and command line) must act before it summarises: a summary while the session has no recorded
  action is rejected with the tools still available, and a session whose agent never acts ends with `error` and an
  empty summary (REQ-EXEC-15/AC8, REQ-EXEC-24/AC8). Ollama models accept `think: true|false` in their capabilities,
  passed to Ollama, because thinking models such as Qwen3 call tools only when it is set.
- f26a0ad: Found by exploratory testing of every qj command:
  
  - `qj projects` alone lists the projects (it printed help and exited 3), and the list reports the same readiness as
    `qj status` (it said "ready" for a project whose tools were missing).
  - Requests to Ollama and OpenAI-compatible providers wait up to `timeout_s` of the provider (default 1800 s) instead
    of Node's 5-minute limit for the first byte, which cut off slow thinking models mid-session.
  - A command-line explorer that answers before acting is shown the first command to run, taken from its checklist;
    qwen3 with a long checklist answered three times without any command before.
  - `qj approve` lists the expectations it cannot check with one marker each (they were prefixed twice).
- 2acbc70: Jira workflow: `workflow:` maps the team's statuses per role; `qj publish` moves the ticket by the computed result
  (all PASSED to "passed", FAILED back to the change's author, anything else stays in testing with a label);
  `qj workflow sync` takes plan approval from `/qj approve v<N>`, `/qj revise` and `/qj reject` comments by a Jira
  group with reminders; one active run per ticket and a daily limit; `qj doctor` checks the mapping. Also: cost per
  verified ticket with cache and dated prices, stage timing and budgets, plan quality, agent scorecard and `qj feedback`,
  prompt caching and input limits, the ticket readiness gate, and `qj reproduce` for certified runs.
  
  Tickets are picked up from the start status (`qj workflow poll`, `qj workflow serve` with a signed webhook).
  Certificates get trusted RFC 3161 timestamps (`certificate.timestamp`, `qj audit timestamp`, checked by
  `qj verify-report --tsa-ca` and `tools/verify-certificate.mjs`), and certified runs can be kept in write-once storage
  on S3 Object Lock (`archive`, new plugin `@qajitsu/adapter-evidence-s3`, `qj audit archive`); locked runs are kept by
  cleanup.
- de3be18: Knowledge base foundations (ADR-0007): `VectorStore` and `Embedder` interfaces with a shared contract suite, document extraction (Markdown, text, HTML, DOCX, OpenAPI per operation) with credential masking and never-indexed files, the `knowledge` section of `qa.project.yaml`, `createEmbedder` in the models layer, and `@qajitsu/adapter-knowledge-lancedb`, the default store embedded in the process.
- 4505978: OpenAI and Gemini models have built-in context windows and prices, and `qj init` proposes their models for an
  OpenAI or Gemini key like for an Anthropic one (REQ-LLM-09/AC6). Prices announced to rise stop being used after the
  day they rise: the cost then shows as unknown rather than too low.
- 5c6c8f2: Stage 2: `qajitsu plan` (analyst + planner on any configured model, grounded sources, interactive review with
  revise/edit, open questions), `qajitsu approve` (SHA-256 freeze) and `qajitsu doctor --models`. Adds analysis and plan
  schemas (published JSON Schemas), plan versioning and diffs, the model registry (Anthropic, OpenAI, Google, Ollama,
  OpenAI-compatible) with capability profiles, the guarded agent loop with structured-output repair, token budget and
  cost journaling, and the plan source checker in the verifier.
- 15a7965: Stage 7: auditor, canary and model benchmark. An independent auditor agent (fresh context, by default a model other
  than the author's) reviews every PASSED case against the approved plan, raw results, text evidence and screenshots;
  its findings and the canary (one PASSED case re-run with an inverted expectation) can only move PASSED to
  NEEDS_REVIEW (`verification` section, `checks/` records protected by the guard, notes in report.html). Every planned
  expectation now needs its own `verify()`: specs that leave one out are blocked, results without it are never PASSED.
  `qajitsu bench --model <ref> [--role]` runs `.qa/bench.yaml` end to end with `--build` and reports detection, false
  FAILED, BLOCKED, plan acceptance, time, tokens and cost. `runStructuredAgent` accepts images; `ModelPorts` accepts a
  run-level model override.
- 5cd2348: Failure hints (REQ-VER-12): a `triage` role suggests product bug, test bug, environment or data for each FAILED case, citing steps, assertions, evidence or logs; code keeps only real citations, hints never change a status, and they show in the matrix, report and Jira comment. `verification.triage: on|off`.

### Patch Changes

- 5661a8c: Core interfaces follow the real seams (ADR-0005): `Runner` is replaced by `AttemptExecutor` with `AttemptRequest`,
  `AttemptRecord` and `EvidenceItem` now in `@qajitsu/core`; `EnvProvider.start()` returns a handle with `baseUrl`,
  `health`, `deployedSha`, `stubs` and `stop()`, implemented by `createRemoteEnvProvider` and
  `createComposeEnvProvider`; `ModelProvider` is the registry shape (`resolve`, `forRole`) that `ModelRegistry`
  extends. Every interface has a shared contract suite in `tests/contract/`.
- c268171: Exploratory sessions: `qj explore <TICKET> --goal "..." [--time-box <min>] [--max-steps <n>]` lets the new `explorer`
  agent explore the application through browser actions QAJitsu performs and records (screenshots, video, trace,
  network, console in the evidence manifest). Observations cite the recorded actions as steps to reproduce; the session
  writes `explore/<session>/report.html` and `report.md` for review and never produces statuses. `qj explore promote`
  turns an observation into a draft plan case with a new `observation` source kind; it runs only after approval.
  `explore/` is protected from agent writes.
- Updated dependencies [322dcb3]
- Updated dependencies [18f9746]
- Updated dependencies [6da421c]
- Updated dependencies [fbf85d7]
- Updated dependencies [c3aea49]
- Updated dependencies [aabdb96]
- Updated dependencies [44e4d71]
- Updated dependencies [016d940]
- Updated dependencies [7384885]
- Updated dependencies [f65a8a4]
- Updated dependencies [9a6d3dc]
- Updated dependencies [f3cf459]
- Updated dependencies [7a85b02]
- Updated dependencies [71f8b88]
- Updated dependencies [f431a44]
- Updated dependencies [e6bc0fd]
- Updated dependencies [b85692f]
- Updated dependencies [8125f74]
- Updated dependencies [a3ab148]
- Updated dependencies [cb3a977]
- Updated dependencies [068ee8d]
- Updated dependencies [4585559]
- Updated dependencies [e387a21]
- Updated dependencies [20ae077]
- Updated dependencies [730f710]
- Updated dependencies [5661a8c]
- Updated dependencies [ac46226]
- Updated dependencies [47fac1e]
- Updated dependencies [7de9efc]
- Updated dependencies [c268171]
- Updated dependencies [693612b]
- Updated dependencies [b17d302]
- Updated dependencies [1b0fc13]
- Updated dependencies [f26a0ad]
- Updated dependencies [1595612]
- Updated dependencies [1049e36]
- Updated dependencies [0a4b201]
- Updated dependencies [59cba3d]
- Updated dependencies [856f330]
- Updated dependencies [44af6d7]
- Updated dependencies [9e47208]
- Updated dependencies [2abbf5d]
- Updated dependencies [2acbc70]
- Updated dependencies [0efd727]
- Updated dependencies [d5a352c]
- Updated dependencies [1d4802f]
- Updated dependencies [de3be18]
- Updated dependencies [e27cccf]
- Updated dependencies [2d298c8]
- Updated dependencies [dcca1a0]
- Updated dependencies [3c66a3b]
- Updated dependencies [112d074]
- Updated dependencies [b13168a]
- Updated dependencies [69a6c09]
- Updated dependencies [52ebfb2]
- Updated dependencies [8a03150]
- Updated dependencies [adb1475]
- Updated dependencies [24d21c4]
- Updated dependencies [be9804d]
- Updated dependencies [3ec9d51]
- Updated dependencies [9876a31]
- Updated dependencies [1384f6e]
- Updated dependencies [016c6f1]
- Updated dependencies [a22d313]
- Updated dependencies [df9aa5c]
- Updated dependencies [ea69cf8]
- Updated dependencies [32c1b62]
- Updated dependencies [254a8c8]
- Updated dependencies [6fb3db3]
- Updated dependencies [6f00289]
- Updated dependencies [353a30c]
- Updated dependencies [7bdae8c]
- Updated dependencies [28ab015]
- Updated dependencies [5c6c8f2]
- Updated dependencies [cbd6fbb]
- Updated dependencies [5c6c8f2]
- Updated dependencies [5c6c8f2]
- Updated dependencies [b447614]
- Updated dependencies [76edd93]
- Updated dependencies [ef6861b]
- Updated dependencies [15a7965]
- Updated dependencies [ee9111a]
- Updated dependencies [b5b577c]
- Updated dependencies [0ecb802]
- Updated dependencies [fc55fef]
- Updated dependencies [08e6842]
- Updated dependencies [5cd2348]
- Updated dependencies [24308e8]
- Updated dependencies [c2d6ffe]
- Updated dependencies [1fc2482]
  - @qajitsu/core@0.1.0
