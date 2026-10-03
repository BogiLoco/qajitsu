# LLM models (LLM)

QAJitsu works with any capable model: cloud APIs, company gateways and local models. Decision: ADR-0003.

### REQ-LLM-01 · Multiple providers

- Status: in-progress
- Priority: must
- Stage: 2
- Related: ADR-0003, INV-11

**Acceptance criteria**

- [x] AC1: Providers through Vercel AI SDK: Anthropic, OpenAI, Google; AWS Bedrock, Azure and Vertex later.
- [x] AC2: Ollama through `ai-sdk-ollama`.
- [x] AC3: Any OpenAI-compatible endpoint (LiteLLM, vLLM, LM Studio) through the OpenAI-compatible provider.
- [ ] AC4: At least one cloud provider and Ollama work in stage 2.
- [x] AC5: Only `packages/models` imports provider SDKs.

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

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-LLM-06

**Acceptance criteria**

- [ ] AC1: Documentation recommends local models for summary and classification roles and states limits for author/healer roles.
- [ ] AC2: Weaker models lead to more BLOCKED, never to false PASSED (guaranteed by REQ-VER-*).

### REQ-LLM-06 · Model benchmark

- Status: accepted
- Priority: should
- Stage: 7
- Related: REQ-NFR-04

**Acceptance criteria**

- [ ] AC1: `qajitsu bench --model <ref> [--role <role>]` runs demo-shop seeded-bug cases with real models.
- [ ] AC2: Reports detection rate, false FAILED, BLOCKED rate, plan acceptance, time and cost.
- [ ] AC3: Never part of PR CI; nightly or on demand only.

### REQ-LLM-07 · Cost and token tracking

- Status: implemented
- Priority: should
- Stage: 2
- Related: REQ-OBS-01

**Acceptance criteria**

- [x] AC1: Tokens and estimated cost per call, role, model and run are recorded in the journal.
- [x] AC2: A per-run token budget stops the run with BLOCKED when exceeded.
