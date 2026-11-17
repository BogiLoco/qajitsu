---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Model profiles from gateways (REQ-LLM-10): an OpenAI-compatible provider marked `gateway: litellm` or
`gateway: openrouter` gets each model's context window, tools, structured output, vision and prices from LiteLLM's
model info or OpenRouter's model list. Declared values win; what nobody states stays unknown. The answer is kept a day
in the project's home with its read time, `qj doctor --models` names where every capability came from, and a gateway
that does not answer is warned about while the configured profiles are used. `qj init` sets OpenRouter up from
`OPENROUTER_API_KEY` and a LiteLLM gateway from `LITELLM_API_KEY` with `LITELLM_BASE_URL`.
