---
"@qajitsu/models": minor
"@qajitsu/cli": minor
---

OpenAI and Gemini models have built-in context windows and prices, and `qj init` proposes their models for an
OpenAI or Gemini key like for an Anthropic one (REQ-LLM-09/AC6). Prices announced to rise stop being used after the
day they rise: the cost then shows as unknown rather than too low.
