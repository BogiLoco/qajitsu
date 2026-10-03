# @qajitsu/models

Model references (`<provider>/<model>`), roles and role-to-model resolution today. Roadmap stage 2 adds providers on Vercel AI SDK: Anthropic, OpenAI, Google, Ollama (`ai-sdk-ollama`) and OpenAI-compatible endpoints for LiteLLM, vLLM and LM Studio, plus capability probes for `qajitsu doctor`.

Requirements: REQ-LLM-01..07. Decision: ADR-0003. Only this package may import provider SDKs (invariant 11).
