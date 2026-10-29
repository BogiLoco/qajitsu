# LLM models (LLM)

QAJitsu works with any capable model: cloud APIs, company gateways and local models. Decision: ADR-0003.

### REQ-LLM-01 · Multiple providers

- Status: implemented
- Priority: must
- Stage: 2
- Related: ADR-0003, INV-11

Verified with a cloud provider on 2026-10-18 (AC4): Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) as analyst, planner, author and healer on the demo shop, with Ollama models in the other roles: `qj doctor --models` (tool calls work for every role), `qj plan DEMO-1` (20 cases, no expectation flagged), and `qj run --build --cases TC-01,TC-02,TC-03` (3 PASSED), for about 0.66 USD. It cannot run in CI without a key; AC6 keeps checking the Anthropic path against the provider's published API documentation (retrieved 2026-10-08).

**Acceptance criteria**

- [x] AC1: Providers through Vercel AI SDK: Anthropic, OpenAI, Google; AWS Bedrock, Azure and Vertex later.
- [x] AC2: Ollama through `ai-sdk-ollama`.
- [x] AC3: Any OpenAI-compatible endpoint (LiteLLM, vLLM, LM Studio) through the OpenAI-compatible provider.
- [x] AC4: At least one cloud provider and Ollama work in stage 2.
- [x] AC5: Only `packages/models` imports provider SDKs.
- [x] AC6: The Anthropic path is verified against the documented Claude Messages API without a key or network: documented headers and fields, no assistant prefill or forced tool use, structured outputs through `output_config.format`, the `tool_use` / `tool_result` round trip, usage of every step, documented 429 and 529 retried and 401 failing at once without the key, and the whole fetch, plan, approve and run flow on the demo shop.
- [x] AC7: A model may take as long as it needs to answer: requests to Ollama and OpenAI-compatible providers wait up to `timeout_s` of the provider (default 1800) instead of the HTTP client's 5-minute limit for the first byte; a slower answer fails with an error naming the timeout, and the time box or a stage stop still cancels a request at once.

### REQ-LLM-02 · Model per role

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-VER-06

**Acceptance criteria**

- [x] AC1: `models.roles` maps roles (analyst, planner, author, healer, auditor, summary) to `<provider>/<model>`, with an optional `default`.
- [x] AC2: Provider definitions (type, base URL, secret reference) live in `models.providers`.

### REQ-LLM-03 · Capability profiles

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-GEN-03

**Acceptance criteria**

- [x] AC1: Each role declares required capabilities: tools, structured output, vision, minimum context window.
- [x] AC2: `qajitsu doctor --models` probes configured models and reports mismatches.
- [x] AC3: A role cannot run on a model missing a required capability.

### REQ-LLM-04 · Structured output with repair

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-PLAN-02

**Acceptance criteria**

- [x] AC1: Agent outputs are validated with Zod.
- [x] AC2: Invalid output is returned to the agent with the validation errors, up to 3 attempts, then the stage fails (no guessing).
- [x] AC3: Models without native structured output use JSON mode plus validation.

### REQ-LLM-05 · Local models used honestly

- Status: implemented
- Priority: should
- Stage: 7
- Related: REQ-LLM-06

**Acceptance criteria**

- [x] AC1: Documentation recommends local models for summary and classification roles and states limits for author/healer roles.
- [x] AC2: Weaker models lead to more BLOCKED, never to false PASSED (guaranteed by REQ-VER-*).

### REQ-LLM-06 · Model benchmark

- Status: implemented
- Priority: should
- Stage: 7
- Related: REQ-NFR-04

**Acceptance criteria**

- [x] AC1: `qajitsu bench --model <ref> [--role <role>]` runs demo-shop seeded-bug cases with real models.
- [x] AC2: Reports detection rate, false FAILED, BLOCKED rate, plan acceptance, time and cost.
- [x] AC3: Never part of PR CI; nightly or on demand only.

### REQ-LLM-07 · Cost and token tracking

- Status: implemented
- Priority: should
- Stage: 2
- Related: REQ-OBS-01

**Acceptance criteria**

- [x] AC1: Tokens and estimated cost per call, role, model and run are recorded in the journal.
- [x] AC2: A per-run token budget stops the run with BLOCKED when exceeded.

### REQ-LLM-08 · Claude Code subscription as a local model provider

- Status: deprecated
- Priority: could
- Stage: later
- Related: REQ-LLM-01, REQ-LLM-02, REQ-LLM-03, REQ-LLM-07, ADR-0003, INV-2, INV-8, INV-11
- Deprecated: removed by the owner on 2026-10-16. Anthropic does not allow third-party products to offer claude.ai login or subscription limits (Agent SDK overview).
- Replaced by REQ-GEN-07

On a workstation a tester can let QAJitsu's roles run on their Claude Code subscription instead of paid API calls,
with a different Claude model per role. CI keeps using API keys. Claude Code only answers prompts: its own tools never
run, and every QAJitsu tool still goes through the guard.

**Acceptance criteria**

- [ ] AC1: A provider of `type: claude-code` runs the local `claude` command in print mode (argument array, no shell) with the role's model (`claude-code/opus`, `claude-code/sonnet`, `claude-code/haiku` or a full model id), so `models.roles` can give each role its own model.
- [ ] AC2: Claude Code's built-in tools are disabled and the user's and project's Claude Code settings, hooks and CLAUDE.md files are not loaded; no session is stored.
- [ ] AC3: Structured answers use Claude Code's JSON schema output and pass the same validation and repair as other providers; a missing `claude` command, a logged-out session or a usage limit fails the stage with the reason, never a guessed result.
- [ ] AC4: Roles that use tools get QAJitsu's read-only tools through an MCP server of QAJitsu that applies the guard and journals every call; without it the provider's profile has no tools.
- [ ] AC5: Tokens and the cost Claude Code reports are recorded per call and role like other providers; the run notes that the subscription was used.
- [ ] AC6: In CI (`CI` set) a `claude-code` role is refused with a message to configure an API provider.

### REQ-LLM-09 · Start with an API key only

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-PRJ-02, REQ-LLM-01, REQ-LLM-03, REQ-LLM-07, REQ-PLAN-08, REQ-CFG-01, INV-8
- Note: accepted by the owner on 2026-10-21. Model ids, context windows and prices of Anthropic, OpenAI and Google were checked on their pages that day (OpenAI and Google added the same day as AC6).

Someone with an API key of a cloud provider should be able to start without declaring model capabilities, context
windows or prices: put the key in `.env.local`, run `qj init`, and go, with a spending limit from the first run.

**Acceptance criteria**

- [x] AC1: `qj init` finds provider keys by their variable names in the environment and the project's `.env.local` (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`), never by reading or printing their values, and proposes that provider with `secret://env/<NAME>` and a model per role; the configuration is written only after the person confirms. A key of a provider without built-in profiles is named with what to set by hand.
- [x] AC2: Well-known cloud models have a built-in profile kept in code with the date it was checked: tools, structured output, vision, context window, and prices per million input and output tokens. A value declared in the project config wins over the built-in one; an unknown model needs its capabilities declared as today.
- [x] AC3: Estimates and tracking show cost in US dollars from these prices; a model without a known price shows the cost as unknown, never as 0.
- [x] AC4: When a paid provider is chosen, `qj init` proposes `budget.max_cost_usd` (default 5); reaching it stops further cases as NOT_RUN (REQ-PLAN-08/AC3) and a model stage that would exceed it as BLOCKED with the reason.
- [x] AC5: `qj doctor --models` checks each key with one minimal call; a rejected key is an error that names the variable, never the value.
- [x] AC6: OpenAI and Google models get built-in profiles and prices checked on their providers' pages, and `qj init` proposes their models like Anthropic's.

### REQ-LLM-10 · Model profiles from gateways (LiteLLM, OpenRouter)

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-LLM-01, REQ-LLM-03, REQ-LLM-09

Behind an OpenAI-compatible gateway the model name tells QAJitsu nothing about its capabilities and price. The
gateways know them; QAJitsu should ask instead of making the user copy them into the config.

**Acceptance criteria**

- [ ] AC1: For an OpenAI-compatible provider marked as a gateway (`gateway: openrouter | litellm`), QAJitsu reads the gateway's model information (OpenRouter's model list, LiteLLM's model info) and uses the context window, supported features and prices it reports as the model's profile.
- [ ] AC2: Values declared in the project config win; a capability the gateway does not report stays unknown, and a role that needs it is refused as in REQ-LLM-03/AC3 with how to declare it. Nothing is assumed.
- [ ] AC3: The information is cached per provider with the time it was read; `qj doctor --models` shows for every capability where it came from (gateway, built-in profile, config).
- [ ] AC4: A gateway that does not answer falls back to the config and built-in profiles with a warning; the key is sent only to that gateway and never logged.

### REQ-LLM-11 · Cost per verified ticket

- Status: implemented
- Priority: should
- Stage: 2
- Related: REQ-LLM-07, REQ-LLM-09, REQ-PLAN-16
- Note: TO BE REVIEWED: the original said prices come only from configuration, never hard-coded; REQ-LLM-09 (accepted 2026-10-21) built in Claude prices with config overrides, so AC3 was adapted to that. Confirm. TO BE REVIEWED (2026-10-22): AC4's web console view moves to REQ-WEB-01, which does not exist yet; a verified ticket is a ticket with a GO or NO-GO decision (REQ-SCALE-10/AC1), and the cost per verified ticket counts every run, also those that decided nothing.

**Acceptance criteria**

- [x] AC1: Tokens (input, cached input, output), model and cost are recorded per agent step and role.
- [x] AC2: Per run and per project: cost per verified ticket, cost per role, runner minutes per ticket and the share of steps done without a model.
- [x] AC3: A price declared in the project config (which wins over the built-in one, REQ-LLM-09/AC2) can carry the date it applies from; costs are computed with the price valid on the day of the call.
- [x] AC4: Trends over time are shown in `qj status` and `qj metrics` (in the web console with REQ-WEB-01); numbers are computed from run records.

### REQ-LLM-12 · Provider cost features: prompt caching and batches

- Status: in-progress
- Priority: should
- Stage: 3
- Related: REQ-LLM-01, REQ-LLM-07, REQ-LLM-11, INV-11

- Note: TO BE REVIEWED (2026-10-22): AC3 (provider batch APIs) is open; AI SDK 7 offers an experimental batch API (`experimental_startBatch`, `getBatchStatus`, `getBatchResults`) that fits audits queued across runs and benchmark preparation, not the dependent steps of one run. AC4 stops a call over its limit; reducing the context automatically is not done.

**Acceptance criteria**

- [x] AC1: Prompts are laid out with a stable prefix (instructions, project rules, repository context) so provider prompt caching applies; cache hits are recorded.
- [x] AC2: The cache duration (short or long) is chosen per project from the observed rate of runs; the choice is recorded.
- [ ] AC3: Work that is not time-critical (benchmarks, nightly regression analysis, queued audits, data preparation) can go through a provider batch API where there is one.
- [x] AC4: The input size of each call is counted before sending; a call that would exceed its step budget or a provider price tier boundary is reduced or stopped with a reason.
- [x] AC5: All of this lives in `packages/models` behind the provider interface (INV-11); other packages only ask for "cacheable" or "batchable" work.

### REQ-LLM-13 · Model routing proposals from data

- Status: proposed
- Priority: could
- Stage: 7
- Related: REQ-LLM-02, REQ-LLM-06, REQ-LLM-11, REQ-VER-14

**Acceptance criteria**

- [ ] AC1: Periodically, recorded costs and benchmark results are compared per role and model (for example the healer on a smaller model with the same success rate).
- [ ] AC2: A cheaper model for a role is proposed only if plan acceptance, coverage and mutation score on the frozen benchmark are not worse.
- [ ] AC3: Proposals are shown with expected savings and the evidence; a person applies them; nothing changes `models.roles` automatically.

### REQ-LLM-14 · Agent scorecard

- Status: implemented
- Priority: should
- Stage: 7
- Related: REQ-LLM-06, REQ-LLM-11, REQ-PLAN-16, REQ-NFR-11, REQ-VER-16, REQ-SKILL-04, INV-1, INV-6
- Note: accepted by the owner on 2026-10-22. Deterministic first: every number comes from recorded data
  (`journal/agents.jsonl`, the journal, gate and review records); an LLM judge is used only offline in benchmarks and
  never affects a status or a reported number.

How well each agent does its job, per role and model, from what every run already records.

**Acceptance criteria**

- [x] AC1: Per role and model, from the agent transcript and the journal: calls, tokens, cost, latency (p50, p95), repair rounds of invalid output, guard denials, and the share of calls that needed no repair.
- [x] AC2: Role outcomes computed by code: the author's share of specs that passed the static checks and the quality gate on the first try, quality findings per rule, review send-backs (REQ-VER-24); the planner's coverage gaps and flagged expectations (REQ-PLAN-14); the healer's healed specs accepted by the assertion lock.
- [x] AC3: `qj metrics` exports the scorecard (Prometheus and JSON) and `qj status` shows it per project; numbers are computed from run records, never estimated by a model.
- [x] AC4: `qj bench` adds the scorecard of each model to its report, with ground truth from the demo shop (seeded bug found, plan covers the bug's criterion), and compares it with the previous result of the same model.
- [x] AC5: Recorded agent answers from benchmark runs can be replayed as scripted models in tests, so changes to parsers and checks are tested against real model output without calling a model.

### REQ-LLM-15 · Context profiles and provider renderers

- Status: implemented
- Priority: must
- Stage: later
- Related: REQ-LLM-03, REQ-LLM-06, REQ-LLM-12, REQ-CTX-12, REQ-SKILL-05, INV-11, ADR-0014

**Acceptance criteria**

- [x] AC1: Each model profile states its context window and its good working range (below the window, from the benchmark of REQ-LLM-06 where measured), the space reserved for the answer, and the profile's version.
- [x] AC2: Tokens are counted with the provider's counting endpoint before sending where there is one; otherwise a local estimate with a margin per model family, because tokenisers differ. The method used is recorded with the call.
- [x] AC3: A renderer per provider turns the neutral context into the provider's form: system message, cache breakpoints (explicit for Anthropic, a stable prefix for OpenAI, none for local models), tool results and structured output.
- [x] AC4: A profile can ask for a compact style for small models (shorter instructions, more examples, fewer fragments at once); the manager applies it without knowing the model.
- [x] AC5: Adding a model or provider means a profile and, for a new provider, a renderer; the context manager does not change. A test with a fake provider shows it.
