# QAJitsu with local models: the Compose stack

`qajitsu stack init` (REQ-GEN-10) writes one `compose.yaml` that runs QAJitsu with local models through Ollama, and
Chroma when the knowledge base uses it. You need Docker Engine (Compose v2) or Podman, nothing else on the machine.

```sh
qj stack init                          # asks for the engine, preset, GPU and port; --yes takes the defaults
docker compose up -d --wait            # the first start pulls the models; later starts find them
docker compose run --rm qajitsu init <slug> --yes --qa-dir .qa   # once: the project in the stack's home
docker compose run --rm qajitsu doctor --models
docker compose run --rm qajitsu run SHOP-482
```

## What is in the file

| Service   | What it is                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `ollama`  | `ollama/ollama` by digest, its port on 127.0.0.1 only, models in the `ollama` volume                           |
| `models`  | a one-shot step on the QAJitsu image: `qajitsu stack pull` pulls each model and checks its digest              |
| `chroma`  | only for `knowledge.store: chroma` without `knowledge.chroma.url`; an external Chroma server stays where it is |
| `qajitsu` | the release image by digest, the project mounted at `/work`, secrets from `.env.local`, started by `run --rm`  |

Every image and every model is pinned by digest: the file names what is pulled, not only a tag that could point to
something else tomorrow. Re-run `qj stack init --force` to move the pins. Check the QAJitsu image before you use it:
[docs/releasing.md](../releasing.md), "Checking an image". A run in the stack records the QAJitsu image, the stack's
other images and the digest of each role's model (`qj runs`, the report).

QAJitsu and the `models` step run as an unprivileged user with every capability dropped and `no-new-privileges`;
Ollama's and Chroma's ports listen on 127.0.0.1 only. `host.docker.internal` lets QAJitsu reach an application under
test on this machine; what QAJitsu may call is still decided by the environment allowlist of `.qa/` (production stays
unreachable unless allowed there).

Secrets never go into the file or the images: the stack reads `.env.local` at run time, the file `stack init` creates
empty (0600) when it is missing. `stack init` refuses to write anything that holds one of its values.

## Presets

Every role of QAJitsu needs a model with certain capabilities (REQ-LLM-03): the author and the auditor 128k tokens of
context and tools, the auditor also vision, the analyst, planner, healer and explorer 64k, summary and triage 32k.
`stack init` reads what each model can do from the Ollama registry (its chat template, its vision projector, the
context length in its header) and refuses a role a model cannot serve, before anything is written.

| Preset   | Models                                                                                                     | Memory, about |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| `small`  | `qwen3:4b` for every text role; the auditor keeps the project's model (or is off)                          | 14 GB         |
| `local`  | `gpt-oss:20b` for the text roles, `qwen3:4b` for summary and triage, `mistral-small3.2:24b` as the auditor | 32 GB         |
| `hybrid` | `qwen3:4b` for analyst, summary and triage; the configured cloud models keep the others                    | 8 GB          |

The memory is what a model needs at the context its roles require, with the stack's `q8_0` key/value cache and flash
attention: a long context costs more than the model itself (`qwen3:4b` at 128k tokens: 2.5 GB of model, 10 GB of
cache). `stack init` prints the estimate per model and warns when the engine has less memory; on Docker Desktop and
Podman machine, give the virtual machine more memory in its settings. Choose any model for a role with
`--model <role>=<name>`; the same checks apply.

## Docker Engine and Podman

- Docker Engine with Compose v2.
- Podman 4.3 or later with `podman compose` and a Compose provider (docker-compose or podman-compose). The project's
  folder is mounted with `:Z` for SELinux and with `userns_mode: keep-id:uid=10001,gid=10001`, so the files QAJitsu
  writes belong to you. Podman names the host `host.containers.internal`; Docker gets `host.docker.internal`.

CI starts the stack on Docker for every pull request and on Podman every night (`stack (docker)`, `stack (podman)`).

## GPU for Ollama

GPU access is optional (`--gpu`); without it Ollama runs on the CPU.

| Platform              | `--gpu`  | What it needs                                                                                                      |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Linux, NVIDIA, Docker | `nvidia` | NVIDIA Container Toolkit; the file reserves the GPUs with `deploy.resources.reservations.devices`                  |
| Linux, NVIDIA, Podman | `nvidia` | the CDI spec: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`; the file asks for `nvidia.com/gpu=all` |
| Linux, AMD            | `amd`    | ROCm drivers; the file uses Ollama's ROCm image and passes `/dev/kfd` and `/dev/dri`                               |
| Windows, NVIDIA       | `nvidia` | Docker Desktop with WSL 2 and a current NVIDIA driver                                                              |
| macOS                 | `none`   | containers get no GPU on macOS; run Ollama natively for Metal, or use `hybrid`                                     |
