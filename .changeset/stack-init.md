---
"@qajitsu/cli": minor
"@qajitsu/models": minor
---

`qj stack init` writes one Compose file that runs QAJitsu with local models (REQ-GEN-10): QAJitsu's release image,
Ollama and, for a knowledge base on Chroma without a server, Chroma, every image and model pinned by digest. It reads
what each model can do from the Ollama registry and refuses a role a model cannot serve, sets `models.roles` to the
models it pulls, estimates each model's memory and warns when the engine has less, and never writes a value of
`.env.local`. A one-shot `models` step (`qj stack pull`) pulls the models at the first start and checks their digests.
Presets `small`, `local` and `hybrid`; Docker Engine and Podman; GPU for NVIDIA and AMD. A run records each Ollama
model's digest and the stack's images. The release image creates QAJitsu's home owned by its user, so a volume mounted
there is writable. New in `@qajitsu/models`: `ollamaPull` and `ollamaTags`.
