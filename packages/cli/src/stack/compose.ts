import { stringify } from "yaml";
import { PINNED_IMAGES, type PinnedImage, type PinnedModel } from "./images.js";
import { STACK_KV_CACHE_TYPE } from "./inspect.js";

/** Container engines the stack runs on (REQ-GEN-10/AC6). */
export const STACK_ENGINES = ["docker", "podman"] as const;
/** GPU access for Ollama (REQ-GEN-10/AC6). */
export const STACK_GPUS = ["none", "nvidia", "amd"] as const;

/** Everything the Compose file is made from; every image and model is already pinned by digest. */
export interface StackPlan {
  /** The project slug: the Compose project is `qajitsu-<slug>`. */
  readonly project: string;
  readonly engine: (typeof STACK_ENGINES)[number];
  readonly gpu: (typeof STACK_GPUS)[number];
  /** Ports on this machine (127.0.0.1) for Ollama and Chroma. */
  readonly ports: { readonly ollama: number; readonly chroma: number };
  /** A named volume, or a host path (it contains `/` or starts with `.`). */
  readonly volumes: { readonly ollama: string; readonly chroma: string; readonly home: string };
  readonly images: {
    readonly qajitsu: PinnedImage;
    readonly ollama: PinnedImage;
    readonly chroma: PinnedImage;
  };
  /** Every model the `models` step pulls: the role models and the embedding model. */
  readonly models: readonly PinnedModel[];
  /** Whether the stack runs Chroma for the knowledge base. */
  readonly chroma: boolean;
  /** `OLLAMA_CONTEXT_LENGTH`: the context Ollama gives every model, as long as the longest its roles need. */
  readonly contextLength: number;
}

/** The Ollama server as the services of the stack reach it. */
export const STACK_OLLAMA_URL = "http://ollama:11434";
/** Chroma as QAJitsu reaches it inside the stack; not a secret, so it is written into the file. */
export const STACK_CHROMA_URL = "http://chroma:8000";

const ref = (image: PinnedImage): string => `${image.repository}:${image.version}@${image.digest}`;
const isPath = (volume: string): boolean => volume.includes("/") || volume.startsWith(".");

/**
 * The `compose.yaml` of a project's stack (REQ-GEN-10/AC2..AC6): Ollama, a one-shot `models` step on the QAJitsu image
 * that pulls and checks every model, Chroma when the knowledge base uses it, and QAJitsu itself, started with
 * `compose run --rm qajitsu <command>`. Images are referenced by digest; secrets reach QAJitsu only from `.env.local`
 * at run time; ports listen on 127.0.0.1.
 *
 * @param plan - The pinned plan.
 * @returns The file's text.
 */
export function renderStackCompose(plan: StackPlan): string {
  const podman = plan.engine === "podman";
  const ollamaImage = plan.gpu === "amd" ? PINNED_IMAGES.ollamaRocm : plan.images.ollama;
  const qajitsu = ref(plan.images.qajitsu);
  const declared = [
    plan.gpu === "amd" ? ollamaImage : plan.images.ollama,
    ...(plan.chroma ? [plan.images.chroma] : []),
  ]
    .map(ref)
    .join(",");

  const ollama: Record<string, unknown> = {
    image: ref(ollamaImage),
    volumes: [`${plan.volumes.ollama}:/root/.ollama`],
    ports: [`127.0.0.1:${String(plan.ports.ollama)}:11434`],
    // Flash attention and a q8_0 cache keep the keys and values of a long context in about half the memory of f16.
    environment: {
      OLLAMA_CONTEXT_LENGTH: String(plan.contextLength),
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: STACK_KV_CACHE_TYPE,
    },
    healthcheck: { test: ["CMD", "ollama", "list"], interval: "10s", timeout: "5s", retries: 30 },
  };
  if (plan.gpu === "nvidia" && !podman)
    ollama["deploy"] = {
      resources: { reservations: { devices: [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }] } },
    };
  if (plan.gpu === "nvidia" && podman) ollama["devices"] = ["nvidia.com/gpu=all"];
  if (plan.gpu === "amd") ollama["devices"] = ["/dev/kfd", "/dev/dri"];

  const services: Record<string, Record<string, unknown>> = {
    ollama,
    models: {
      image: qajitsu,
      command: [
        "stack",
        "pull",
        "--ollama",
        STACK_OLLAMA_URL,
        ...plan.models.map((m) => `${m.name}@${m.digest}`),
      ],
      depends_on: { ollama: { condition: "service_healthy" } },
      restart: "no",
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
    },
  };
  if (plan.chroma)
    services["chroma"] = {
      image: ref(plan.images.chroma),
      volumes: [`${plan.volumes.chroma}:/data`],
      ports: [`127.0.0.1:${String(plan.ports.chroma)}:8000`],
    };
  services["qajitsu"] = {
    image: qajitsu,
    profiles: ["cli"],
    working_dir: "/work",
    // QAJitsu runs as an unprivileged user and its browser without the setuid sandbox: it needs no capability.
    security_opt: ["no-new-privileges:true"],
    cap_drop: ["ALL"],
    volumes: [podman ? ".:/work:Z" : ".:/work", `${plan.volumes.home}:/home/qa/.qajitsu`],
    ...(podman ? { userns_mode: "keep-id:uid=10001,gid=10001" } : {}),
    // The short form every Compose (and podman-compose) reads; `stack init` creates an empty file when there is none.
    env_file: [".env.local"],
    environment: {
      QAJITSU_IMAGE_DIGEST: plan.images.qajitsu.digest,
      QAJITSU_STACK_IMAGES: declared,
      ...(plan.chroma ? { QAJITSU_CHROMA_URL: STACK_CHROMA_URL } : {}),
    },
    depends_on: {
      models: { condition: "service_completed_successfully" },
      ...(plan.chroma ? { chroma: { condition: "service_started" } } : {}),
    },
    // The application under test usually runs on this machine: Docker names it host.docker.internal when asked to,
    // Podman names it host.containers.internal by itself (and older versions refuse host-gateway).
    ...(podman ? {} : { extra_hosts: ["host.docker.internal:host-gateway"] }),
  };

  const named = [
    plan.volumes.ollama,
    ...(plan.chroma ? [plan.volumes.chroma] : []),
    plan.volumes.home,
  ].filter((v) => !isPath(v));
  return [
    "# Written by `qajitsu stack init` (REQ-GEN-10). Images and models are pinned by digest; re-run it to move them.",
    "# Start: docker compose up -d --wait    Run: docker compose run --rm qajitsu run <TICKET>",
    stringify(
      {
        name: `qajitsu-${plan.project}`,
        services,
        ...(named.length > 0 ? { volumes: Object.fromEntries([...new Set(named)].map((v) => [v, {}])) } : {}),
      },
      { lineWidth: 0 },
    ),
  ].join("\n");
}
