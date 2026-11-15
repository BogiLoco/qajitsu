import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderStackCompose, type StackPlan } from "./compose.js";
import { PINNED_IMAGES, presetRoles } from "./images.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const plan = (over: Partial<StackPlan> = {}): StackPlan => ({
  project: "shop",
  engine: "docker",
  gpu: "none",
  ports: { ollama: 11434, chroma: 8000 },
  volumes: { ollama: "ollama", chroma: "chroma", home: "qajitsu-home" },
  images: {
    qajitsu: { repository: "ghcr.io/bogiloco/qajitsu", version: "0.1.0", digest: d("1") },
    ollama: PINNED_IMAGES.ollama,
    chroma: PINNED_IMAGES.chroma,
  },
  models: [
    { name: "qwen3:4b", digest: d("a") },
    { name: "nomic-embed-text:latest", digest: d("b") },
  ],
  chroma: false,
  contextLength: 131_072,
  ...over,
});
interface Compose {
  name: string;
  services: Record<string, Record<string, unknown>>;
  volumes?: Record<string, unknown>;
}
const compose = (p: StackPlan) => parse(renderStackCompose(p)) as Compose;

describe("the Compose stack (REQ-GEN-10)", () => {
  it("REQ-GEN-10/AC2: QAJitsu, Ollama and the model step; Chroma only when the knowledge base uses it", () => {
    const c = compose(plan());
    expect(c.name).toBe("qajitsu-shop");
    expect(Object.keys(c.services).sort()).toEqual(["models", "ollama", "qajitsu"]);
    expect(Object.keys(compose(plan({ chroma: true })).services).sort()).toEqual([
      "chroma",
      "models",
      "ollama",
      "qajitsu",
    ]);
    // QAJitsu waits for the models and, when there is one, for Chroma; it is started by `compose run`.
    expect(c.services["qajitsu"]).toMatchObject({
      profiles: ["cli"],
      working_dir: "/work",
      depends_on: { models: { condition: "service_completed_successfully" } },
      extra_hosts: ["host.docker.internal:host-gateway"],
    });
    expect(compose(plan({ chroma: true })).services["qajitsu"]?.["depends_on"]).toMatchObject({
      chroma: { condition: "service_started" },
    });
    expect(c.services["models"]?.["depends_on"]).toEqual({ ollama: { condition: "service_healthy" } });
    // The stack's own containers drop every capability and cannot gain privileges.
    for (const name of ["qajitsu", "models"]) {
      expect(c.services[name]?.["security_opt"], name).toEqual(["no-new-privileges:true"]);
      expect(c.services[name]?.["cap_drop"], name).toEqual(["ALL"]);
    }
    // Ollama gives every model the context its roles were checked for.
    expect(c.services["ollama"]?.["environment"]).toEqual({
      OLLAMA_CONTEXT_LENGTH: "131072",
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
    });
  });

  it("REQ-GEN-10/AC2: ports and volumes come from the options; ports listen on this machine only", () => {
    const c = compose(
      plan({
        chroma: true,
        ports: { ollama: 21434, chroma: 18000 },
        volumes: { ollama: "/srv/models", chroma: "chroma-data", home: "./.qajitsu-home" },
      }),
    );
    expect(c.services["ollama"]?.["ports"]).toEqual(["127.0.0.1:21434:11434"]);
    expect(c.services["chroma"]?.["ports"]).toEqual(["127.0.0.1:18000:8000"]);
    expect(c.services["ollama"]?.["volumes"]).toEqual(["/srv/models:/root/.ollama"]);
    expect(c.services["chroma"]?.["volumes"]).toEqual(["chroma-data:/data"]);
    expect(c.services["qajitsu"]?.["volumes"]).toEqual([".:/work", "./.qajitsu-home:/home/qa/.qajitsu"]);
    // Only named volumes are declared; host paths are bind mounts.
    expect(Object.keys(c.volumes ?? {}).sort()).toEqual(["chroma-data"]);
  });

  it("REQ-GEN-10/AC4: every image is referenced by digest, and the model step pulls each model by name@digest", () => {
    const text = renderStackCompose(plan({ chroma: true }));
    const c = parse(text) as Compose;
    for (const [name, service] of Object.entries(c.services))
      expect(String(service["image"]), name).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(c.services["qajitsu"]?.["image"]).toBe(`ghcr.io/bogiloco/qajitsu:0.1.0@${d("1")}`);
    expect(c.services["models"]?.["image"]).toBe(c.services["qajitsu"]?.["image"]);
    expect(c.services["models"]?.["command"]).toEqual([
      "stack",
      "pull",
      "--ollama",
      "http://ollama:11434",
      `qwen3:4b@${d("a")}`,
      `nomic-embed-text:latest@${d("b")}`,
    ]);
    // The run inside records the digests it was started with (REQ-OBS-10).
    expect(c.services["qajitsu"]?.["environment"]).toMatchObject({
      QAJITSU_IMAGE_DIGEST: d("1"),
      QAJITSU_STACK_IMAGES: `${PINNED_IMAGES.ollama.repository}:${PINNED_IMAGES.ollama.version}@${PINNED_IMAGES.ollama.digest},${PINNED_IMAGES.chroma.repository}:${PINNED_IMAGES.chroma.version}@${PINNED_IMAGES.chroma.digest}`,
      QAJITSU_CHROMA_URL: "http://chroma:8000",
    });
    expect(text).not.toMatch(/:latest\s*$|image: [^@\n]+$/m);
  });

  it("REQ-GEN-10/AC5: secrets reach QAJitsu only through .env.local at run time", () => {
    const c = compose(plan({ chroma: true }));
    expect(c.services["qajitsu"]?.["env_file"]).toEqual([".env.local"]);
    for (const [name, service] of Object.entries(c.services)) {
      if (name !== "qajitsu") expect(service["env_file"], name).toBeUndefined();
      for (const [key, value] of Object.entries((service["environment"] ?? {}) as Record<string, string>)) {
        expect(key, name).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY/i);
        expect(value, `${name} ${key}`).not.toMatch(/^secret:\/\//);
      }
    }
  });

  it("REQ-GEN-10/AC6: GPU for Ollama per engine: NVIDIA on Docker and on Podman (CDI), AMD with ROCm", () => {
    expect(compose(plan()).services["ollama"]?.["deploy"]).toBeUndefined();
    expect(compose(plan()).services["ollama"]?.["devices"]).toBeUndefined();
    expect(compose(plan({ gpu: "nvidia" })).services["ollama"]?.["deploy"]).toEqual({
      resources: { reservations: { devices: [{ driver: "nvidia", count: "all", capabilities: ["gpu"] }] } },
    });
    const podman = compose(plan({ gpu: "nvidia", engine: "podman" })).services["ollama"];
    expect(podman?.["devices"]).toEqual(["nvidia.com/gpu=all"]);
    expect(podman?.["deploy"]).toBeUndefined();
    const amd = compose(plan({ gpu: "amd" })).services["ollama"];
    expect(amd?.["image"]).toBe(
      `${PINNED_IMAGES.ollamaRocm.repository}:${PINNED_IMAGES.ollamaRocm.version}@${PINNED_IMAGES.ollamaRocm.digest}`,
    );
    expect(amd?.["devices"]).toEqual(["/dev/kfd", "/dev/dri"]);
    // Podman labels the project's bind mount for SELinux and keeps the files owned by the user who started it.
    const pq = compose(plan({ engine: "podman" })).services["qajitsu"];
    expect(pq?.["volumes"]).toEqual([".:/work:Z", "qajitsu-home:/home/qa/.qajitsu"]);
    expect(pq?.["userns_mode"]).toBe("keep-id:uid=10001,gid=10001");
    expect(compose(plan()).services["qajitsu"]?.["userns_mode"]).toBeUndefined();
    expect(pq?.["extra_hosts"]).toBeUndefined();
  });

  it("REQ-GEN-10/AC2: the presets name models whose tools, vision and context fit their roles", () => {
    expect(presetRoles("small")).toEqual({ default: "qwen3:4b" });
    expect(presetRoles("local")).toEqual({
      default: "gpt-oss:20b",
      summary: "qwen3:4b",
      triage: "qwen3:4b",
      auditor: "mistral-small3.2:24b",
    });
    expect(presetRoles("hybrid")).toEqual({ analyst: "qwen3:4b", summary: "qwen3:4b", triage: "qwen3:4b" });
    // A preset that sets the auditor never gives it the author's model (REQ-VER-06).
    for (const preset of ["small", "local", "hybrid"] as const) {
      const roles = presetRoles(preset);
      if (roles["auditor"] !== undefined)
        expect(roles["auditor"], preset).not.toBe(roles["author"] ?? roles["default"]);
    }
  });

  it("REQ-GEN-10/AC4: the pinned Ollama and Chroma images carry versions and sha256 index digests", () => {
    for (const [name, image] of Object.entries(PINNED_IMAGES)) {
      expect(image.digest, name).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(image.version, name).toMatch(/^\d+\.\d+\.\d+(-rocm)?$/);
    }
  });
});
