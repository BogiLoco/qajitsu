# ADR-0016: The Compose stack pins everything at init and checks its models before it is written

- Status: accepted
- Date: 2026-11-15
- Related: REQ-GEN-10, REQ-GEN-09, REQ-LLM-03, REQ-OBS-10, REQ-VER-06, INV-8, INV-10

## Context

REQ-GEN-10 asks for one Compose file that runs QAJitsu with local models. A first plan let presets name popular Ollama
models and left it to `qajitsu doctor --models` to say whether they fit. Running the stack against a real Ollama showed
why that is not enough:

- QAJitsu's roles have hard minimums (REQ-LLM-03): the author and the auditor need 128k tokens of context and tools,
  the auditor also vision. Most popular local models miss one of them (qwen3:8b and :14b know 40k tokens, gemma3 has
  no tools in Ollama), so such a stack fails every role at its first use.
- QAJitsu asks Ollama for the context its profile of the model states, not for Ollama's default. At 128k tokens the
  key/value cache of a 4B model needs 18 GB in f16, more than the model itself and more than a laptop's Docker VM.
- A tag such as `qwen3:4b` or `ollama/ollama:latest` can point at other bytes tomorrow, so a stack written from tags
  is not the stack that was checked.

## Decision

`qajitsu stack init` decides and pins everything once, before it writes anything:

- **Digests, not tags.** QAJitsu's image by the digest of its release index (GHCR) or by `--image ref@sha256`, Ollama
  and Chroma by hand-moved pins, every model by the SHA-256 of its manifest in the Ollama registry, which is the digest
  Ollama lists once the model is pulled. A run records all of them (REQ-OBS-10).
- **Capabilities from the model's own files.** For each model the registry gives its chat template (tools), a vision
  projector or vision keys, and the first megabytes of the model file (context length and attention shape, from the
  GGUF header). The roles are checked with `missingCapabilities`, the check `doctor --models` uses, and an auditor
  with the author's model is refused (REQ-VER-06). What was read is declared under `models.providers.stack.models`, so
  QAJitsu's own check agrees at run time.
- **Memory is said, not discovered.** Ollama gets `OLLAMA_CONTEXT_LENGTH` for the longest context a role needs, flash
  attention and a `q8_0` cache. `stack init` estimates each model's memory at that context and warns when the engine
  has less; it does not refuse, since the engine's memory can be changed.
- **The models are pulled by the QAJitsu image.** A one-shot `models` service runs `qajitsu stack pull`, which pulls
  each model and fails, naming it, when Ollama then holds another digest. No shell step in the Compose file, so the
  logic is tested code, and a restart pulls nothing again.
- **No secret anywhere.** Secrets reach the stack only from `.env.local` at run time; options and the rendered files
  are checked against its values before any request or write (INV-8).

Presets follow from the checks, not the other way round: `small` (`qwen3:4b`, the auditor keeps the project's model),
`local` (`gpt-oss:20b`, `qwen3:4b`, `mistral-small3.2:24b` as the auditor), `hybrid` (local models only where 32k or
64k is enough).

## Consequences

- `stack init` needs the Ollama registry and GHCR once; offline it needs `--image` and `--model name@digest`, and
  still the registry for the capabilities.
- Moving a model or an image is a re-run of `stack init --force`, visible as a diff of `compose.yaml`.
- A machine with too little memory learns it from the warning, before gigabytes are pulled; the lab that found the
  limits had an 8 GB Docker VM.
- The Android image (REQ-GEN-10/AC1) and Docker Hub come later; the stack takes QAJitsu's image as it is published.
