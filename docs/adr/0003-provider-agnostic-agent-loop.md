# 0003. Own agent loop on Vercel AI SDK for multi-provider LLM support

- Status: Accepted
- Date: 2026-10-03
- Related: REQ-LLM-01, REQ-LLM-02, REQ-LLM-03, INV-9, INV-11; plan section 4

## Context

QAJitsu must work with cloud models, company gateways such as LiteLLM, and local models served by Ollama, with a model chosen per agent role. Tool guarding and journaling must behave identically regardless of the model.

## Decision

Implement a small agent loop in `packages/agents` on top of Vercel AI SDK. Provider access lives in `packages/models` (AI SDK providers, `ai-sdk-ollama`, OpenAI-compatible provider for LiteLLM, vLLM and LM Studio). MCP tools are attached through `@ai-sdk/mcp`. The guard wraps every tool call in our own code. Each role declares required capabilities (tools, structured output, vision, context window) checked by `qajitsu doctor`.

## Alternatives considered

- **Claude Agent SDK as the core**: excellent loop and built-in tools, but tied to Claude models; routing other models through a translation proxy adds a fragile layer.
- **LangGraph.js or Mastra**: more framework than needed; the orchestration here is a deterministic state machine, not an agent graph.

## Consequences

- Good: any provider, one guard implementation, model per role, local-only operation possible.
- Bad: we maintain file and search tools and the loop ourselves; weaker local models will produce more BLOCKED outcomes, which `qajitsu bench` measures.
