# Model gateway fixtures (REQ-LLM-10)

- `litellm-model-info.json`: `GET /model/info` of a real LiteLLM proxy (main-stable, 2026-11-17) with three models:
  `strong` and `fast` (models LiteLLM knows), `inhouse` (a model only its own `model_info` describes). Trimmed to the
  fields QAJitsu reads; LiteLLM leaves out the `api_key` of `litellm_params` itself, the internal `api_base` is
  replaced by an example host.
- `openrouter-models.json`: three entries of OpenRouter's public `GET /api/v1/models` (2026-11-17), one of them a
  model without tools.
