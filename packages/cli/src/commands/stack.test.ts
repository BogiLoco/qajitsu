import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createFakeFetch, jsonReply, textReply, type Route } from "../../../../tests/support/fake-fetch.js";
import { fakeModelDigest, ollamaRegistryRoutes } from "../../../../tests/support/ollama-registry.js";
import { runStackInit, runStackPull } from "./stack.js";

const IMAGE = `ghcr.io/bogiloco/qajitsu:0.1.0@sha256:${"1".repeat(64)}`;
const dig = (c: string) => `sha256:${c.repeat(64)}`;
const CONFIG = [
  "project: shop",
  "jira: { type: file, tickets_dir: ../tickets, project_key: SHOP }",
  "code_hosts: { local: { type: local, root: ~/git } }",
  "repos: { shop: { host: local, path: shop-org/shop } }",
  "environments: { allowlist: ['http://localhost:3000'] }",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const project = async (config = CONFIG, envLocal?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "qj-stack-"));
  dirs.push(dir);
  await mkdir(join(dir, ".qa"));
  await writeFile(join(dir, ".qa", "qa.project.yaml"), config);
  if (envLocal !== undefined) await writeFile(join(dir, ".env.local"), envLocal);
  return dir;
};
/** The Ollama registry with the real models' capabilities. */
const registry = ollamaRegistryRoutes();
const io = (cwd: string, answers: string[] = []) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd,
      write: (t: string) => out.push(t),
      writeError: (t: string) => err.push(t),
      ask: answers.length > 0 ? () => Promise.resolve(answers.shift() ?? "") : undefined,
    },
  };
};
interface Compose {
  services: Record<string, Record<string, unknown>>;
}

describe("qajitsu stack init (REQ-GEN-10/AC2..AC5)", () => {
  it("REQ-GEN-10/AC2: --yes writes compose.yaml from the options and sets models.roles", async () => {
    const dir = await project();
    const fake = createFakeFetch(registry);
    const t = io(dir);
    const code = await runStackInit({ yes: true, preset: "local", image: IMAGE, ollamaPort: "21434" }, t.io, {
      fetch: fake.fetch,
    });
    expect(t.err.join("")).toBe("");
    expect(code).toBe(0);
    const compose = parse(await readFile(join(dir, "compose.yaml"), "utf8")) as Compose;
    expect(Object.keys(compose.services).sort()).toEqual(["models", "ollama", "qajitsu"]);
    expect(compose.services["ollama"]?.["ports"]).toEqual(["127.0.0.1:21434:11434"]);
    expect(compose.services["ollama"]?.["environment"]).toEqual({
      OLLAMA_CONTEXT_LENGTH: "131072",
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
    });
    expect(compose.services["qajitsu"]?.["image"]).toBe(IMAGE);
    const pulled = (compose.services["models"]?.["command"] as string[]).slice(4);
    expect(pulled).toEqual(
      ["gpt-oss:20b", "mistral-small3.2:24b", "nomic-embed-text:latest", "qwen3:4b"].map(
        (m) => `${m}@${fakeModelDigest(m)}`,
      ),
    );
    const config = parse(await readFile(join(dir, ".qa", "qa.project.yaml"), "utf8")) as {
      models: { providers: { stack: { models: Record<string, unknown> } }; roles: Record<string, string> };
      knowledge: { embedding: string };
    };
    expect(config.models.roles).toEqual({
      default: "stack/gpt-oss:20b",
      summary: "stack/qwen3:4b",
      triage: "stack/qwen3:4b",
      auditor: "stack/mistral-small3.2:24b",
    });
    // QAJitsu has no built-in profile of these models: what the registry says they can do is declared for it.
    expect(config.models.providers.stack.models).toEqual({
      "gpt-oss:20b": { tools: true, structured_output: true, vision: false, context_window: 131072 },
      "mistral-small3.2:24b": { tools: true, structured_output: true, vision: true, context_window: 131072 },
      "qwen3:4b": { tools: true, structured_output: true, vision: false, context_window: 131072 },
    });
    expect(config.knowledge.embedding).toBe("stack/nomic-embed-text:latest");
    expect(t.out.join("")).toContain("compose up -d --wait");
    expect(t.out.join("")).toContain("compose run --rm qajitsu init shop --yes --qa-dir .qa");
    // Compose needs the env file it names: an empty one, private to its owner, when there was none.
    const env = await stat(join(dir, ".env.local"));
    expect(env.size).toBe(0);
    if (process.platform !== "win32") expect(env.mode & 0o777).toBe(0o600);
  });

  it("REQ-GEN-10/AC3: a role the stack's model cannot serve is refused before anything is written", async () => {
    const fake = createFakeFetch(registry);
    // small: qwen3:4b has no vision, so it cannot be the auditor, and it is the author's model.
    const dir = await project();
    const t = io(dir);
    expect(
      await runStackInit({ yes: true, preset: "small", image: IMAGE }, t.io, { fetch: fake.fetch }),
    ).toBe(3);
    expect(t.err.join("")).toContain("auditor: qwen3:4b lacks vision");
    await expect(readFile(join(dir, "compose.yaml"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dir, ".qa", "qa.project.yaml"), "utf8")).toBe(CONFIG);
    // With the auditor switched off, small serves every other role.
    const off = await project(CONFIG.concat("verification: { auditor: off }\n"));
    expect(
      await runStackInit({ yes: true, preset: "small", image: IMAGE }, io(off).io, { fetch: fake.fetch }),
    ).toBe(0);
    // A model without tools as the author, or with too short a context, is named with what it lacks.
    const bad = io(await project());
    expect(
      await runStackInit(
        { yes: true, preset: "local", image: IMAGE, model: ["author=gemma3:4b", "planner=qwen3:8b"] },
        bad.io,
        { fetch: fake.fetch },
      ),
    ).toBe(3);
    expect(bad.err.join("")).toContain("author: gemma3:4b lacks tools");
    expect(bad.err.join("")).toContain("planner: qwen3:8b lacks contextWindow>=64000");
    // A model the registry does not have stops it too.
    const unknown = io(await project());
    expect(
      await runStackInit(
        { yes: true, preset: "local", image: IMAGE, model: ["summary=no-such:1b"] },
        unknown.io,
        {
          fetch: fake.fetch,
        },
      ),
    ).toBe(3);
    expect(unknown.err.join("")).toContain("no-such:1b could not be inspected in the Ollama registry");
  });

  it("REQ-GEN-10/AC2: the questionnaire's answers become the parameters; Enter keeps the proposal", async () => {
    const dir = await project();
    const fake = createFakeFetch(registry);
    const t = io(dir, ["podman", "", "nvidia", ""]);
    expect(await runStackInit({ image: IMAGE }, t.io, { fetch: fake.fetch })).toBe(0);
    const compose = parse(await readFile(join(dir, "compose.yaml"), "utf8")) as Compose;
    // podman, the proposed preset (local), an NVIDIA GPU through CDI, the proposed port.
    expect(compose.services["ollama"]?.["devices"]).toEqual(["nvidia.com/gpu=all"]);
    expect(compose.services["ollama"]?.["ports"]).toEqual(["127.0.0.1:11434:11434"]);
    expect((compose.services["models"]?.["command"] as string[]).join(" ")).toContain("gpt-oss:20b@");
    // A wrong answer is refused, not guessed.
    const bad = io(await project(), ["kubernetes"]);
    expect(await runStackInit({ image: IMAGE }, bad.io, { fetch: fake.fetch })).toBe(3);
    expect(bad.err.join("")).toContain("expected one of docker, podman");
  });

  it("REQ-GEN-10/AC2: an existing compose.yaml is kept unless --force", async () => {
    const dir = await project();
    await writeFile(join(dir, "compose.yaml"), "services: { mine: { image: x } }\n");
    const fake = createFakeFetch(registry);
    const t = io(dir);
    expect(await runStackInit({ yes: true, image: IMAGE }, t.io, { fetch: fake.fetch })).toBe(3);
    expect(t.err.join("")).toContain("--force");
    expect(await readFile(join(dir, "compose.yaml"), "utf8")).toBe("services: { mine: { image: x } }\n");
    expect(await readFile(join(dir, ".qa", "qa.project.yaml"), "utf8")).toBe(CONFIG);
    expect(
      await runStackInit({ yes: true, image: IMAGE, force: true }, io(dir).io, { fetch: fake.fetch }),
    ).toBe(0);
  });

  it("REQ-GEN-10/AC3+AC4: --model sets a role; a digest given with it is the one written", async () => {
    const dir = await project();
    const fake = createFakeFetch(registry);
    const code = await runStackInit(
      {
        yes: true,
        preset: "local",
        image: IMAGE,
        model: [`summary=qwen3:8b@${dig("a")}`, "triage=qwen3:8b"],
      },
      io(dir).io,
      { fetch: fake.fetch },
    );
    expect(code).toBe(0);
    const command = (parse(await readFile(join(dir, "compose.yaml"), "utf8")) as Compose).services[
      "models"
    ]?.["command"] as string[];
    expect(command).toContain(`qwen3:8b@${dig("a")}`);
    expect(command.filter((c) => c.startsWith("qwen3:8b@"))).toHaveLength(1);
    const roles = (
      parse(await readFile(join(dir, ".qa", "qa.project.yaml"), "utf8")) as {
        models: { roles: Record<string, string> };
      }
    ).models.roles;
    expect(roles).toMatchObject({ summary: "stack/qwen3:8b", triage: "stack/qwen3:8b" });
  });

  it("REQ-GEN-10/AC4: without --image the release image of this version is asked from GHCR, and a missing one stops", async () => {
    const dir = await project();
    const fake = createFakeFetch([
      ...registry,
      { match: /^\/token/, reply: jsonReply({ token: "anon" }) },
      { method: "HEAD", match: /^\/v2\/bogiloco\/qajitsu\/manifests\//, reply: textReply("", 404) },
    ]);
    const t = io(dir);
    expect(await runStackInit({ yes: true }, t.io, { fetch: fake.fetch })).toBe(3);
    expect(t.err.join("")).toMatch(/is not published.*--image/);
    await expect(readFile(join(dir, "compose.yaml"), "utf8")).rejects.toThrow();
    // A tag without a digest is not an image the stack can pin.
    const tag = io(dir);
    expect(
      await runStackInit({ yes: true, image: "ghcr.io/bogiloco/qajitsu:0.1.0" }, tag.io, {
        fetch: fake.fetch,
      }),
    ).toBe(3);
    expect(tag.err.join("")).toContain("no sha256 digest");
  });

  it("REQ-GEN-10/AC2: hybrid keeps the cloud planner, author and healer and refuses when they are not configured", async () => {
    const fake = createFakeFetch(registry);
    const bare = io(await project());
    expect(
      await runStackInit({ yes: true, preset: "hybrid", image: IMAGE }, bare.io, { fetch: fake.fetch }),
    ).toBe(3);
    expect(bare.err.join("")).toContain("models.roles.planner is not set");
    const cloud = CONFIG.concat(
      [
        "models:",
        "  providers: { claude: { type: anthropic, api_key: 'secret://env/ANTHROPIC_API_KEY' } }",
        "  roles: { planner: claude/claude-sonnet-5, author: claude/claude-sonnet-5, healer: claude/claude-sonnet-5 }",
        "",
      ].join("\n"),
    );
    const dir = await project(cloud);
    expect(
      await runStackInit({ yes: true, preset: "hybrid", image: IMAGE }, io(dir).io, { fetch: fake.fetch }),
    ).toBe(0);
    const roles = (
      parse(await readFile(join(dir, ".qa", "qa.project.yaml"), "utf8")) as {
        models: { roles: Record<string, string> };
      }
    ).models.roles;
    expect(roles).toMatchObject({ planner: "claude/claude-sonnet-5", analyst: "stack/qwen3:4b" });
  });

  it("REQ-GEN-10/AC2: Chroma joins the stack for a knowledge base on Chroma without a server; an external one stays", async () => {
    const fake = createFakeFetch(registry);
    const own = await project(CONFIG.concat("knowledge: { store: chroma }\n"));
    expect(await runStackInit({ yes: true, image: IMAGE }, io(own).io, { fetch: fake.fetch })).toBe(0);
    expect(
      Object.keys((parse(await readFile(join(own, "compose.yaml"), "utf8")) as Compose).services),
    ).toContain("chroma");
    const external = await project(
      CONFIG.concat("knowledge: { store: chroma, chroma: { url: 'secret://env/TEAM_CHROMA_URL' } }\n"),
    );
    expect(await runStackInit({ yes: true, image: IMAGE }, io(external).io, { fetch: fake.fetch })).toBe(0);
    expect(
      Object.keys((parse(await readFile(join(external, "compose.yaml"), "utf8")) as Compose).services),
    ).not.toContain("chroma");
    expect(await readFile(join(external, ".qa", "qa.project.yaml"), "utf8")).toContain(
      "secret://env/TEAM_CHROMA_URL",
    );
  });

  it("REQ-GEN-10/AC3: each model's memory at the stack's context is shown, and a machine with too little is warned", async () => {
    const dir = await project(CONFIG.concat("verification: { auditor: off }\n"));
    const fake = createFakeFetch(registry);
    const eightGb = (cmd: string, args: readonly string[]) =>
      Promise.resolve(cmd === "docker" && args[0] === "info" ? "8225546240" : "Docker version 27.0.0");
    const t = io(dir);
    expect(
      await runStackInit({ yes: true, preset: "small", image: IMAGE }, t.io, {
        fetch: fake.fetch,
        versionExec: eightGb,
      }),
    ).toBe(0);
    const out = t.out.join("");
    // qwen3:4b at 131072 tokens with a q8_0 cache: 2.5 GB of model, 10.3 GB of keys and values, 0.5 GB more.
    expect(out).toMatch(/model {4}qwen3:4b@sha256:\S+ {2}needs about 13\.3 GB/);
    expect(out).toContain("Warning: qwen3:4b needs about 13.3 GB at 131072 tokens and docker has 8.2 GB");
    // Enough memory: no warning; the files are written either way.
    const plenty = io(dir);
    const big = (cmd: string, args: readonly string[]) =>
      Promise.resolve(cmd === "docker" && args[0] === "info" ? String(64e9) : "Docker version 27.0.0");
    expect(
      await runStackInit({ yes: true, force: true, preset: "small", image: IMAGE }, plenty.io, {
        fetch: fake.fetch,
        versionExec: big,
      }),
    ).toBe(0);
    expect(plenty.out.join("")).not.toMatch(/Warning: \S+ needs about/);
  });

  it("REQ-GEN-10/AC5: a volume may not be the host's root or an engine socket, and only known roles take a model", async () => {
    const fake = createFakeFetch(registry);
    for (const volume of [
      "home=/",
      "home=/var/run/docker.sock",
      "ollama=/run/podman/podman.sock",
      "home=a:b",
      "home=../up",
      "home=$(id)",
    ]) {
      const t = io(await project());
      expect(
        await runStackInit({ yes: true, image: IMAGE, volume: [volume] }, t.io, { fetch: fake.fetch }),
        volume,
      ).toBe(3);
      expect(t.err.join(""), volume).toContain("not the host's root or an engine socket");
      expect(fake.requests, volume).toEqual([]);
    }
    const role = io(await project());
    expect(
      await runStackInit({ yes: true, image: IMAGE, model: ["boss=qwen3:4b"] }, role.io, {
        fetch: fake.fetch,
      }),
    ).toBe(3);
    expect(role.err.join("")).toContain("boss is no role");
  });

  it("REQ-GEN-10/AC5: .env.local is created private and never replaced; a readable one or a missing .gitignore entry is warned", async () => {
    const fake = createFakeFetch(registry);
    const dir = await project(
      CONFIG.concat("verification: { auditor: off }\n"),
      "JIRA_TOKEN=fictional-value-1234\n",
    );
    await chmod(join(dir, ".env.local"), 0o644);
    const t = io(dir);
    expect(
      await runStackInit({ yes: true, preset: "small", image: IMAGE }, t.io, { fetch: fake.fetch }),
    ).toBe(0);
    expect(await readFile(join(dir, ".env.local"), "utf8")).toBe("JIRA_TOKEN=fictional-value-1234\n");
    if (process.platform !== "win32")
      expect(t.out.join("")).toContain("can be read by other users (mode 644)");
    expect(t.out.join("")).toContain(".gitignore does not exclude .env.local");
    await writeFile(join(dir, ".gitignore"), "node_modules\n.env.local\n");
    await chmod(join(dir, ".env.local"), 0o600);
    const quiet = io(dir);
    expect(
      await runStackInit({ yes: true, force: true, preset: "small", image: IMAGE }, quiet.io, {
        fetch: fake.fetch,
      }),
    ).toBe(0);
    expect(quiet.out.join("")).not.toContain("can be read by other users");
    expect(quiet.out.join("")).not.toContain(".gitignore does not exclude");
  });

  it("REQ-GEN-10/AC5: an answer or option holding a value of .env.local is masked in the error", async () => {
    const secret = ["fictional", "-", "secret", "-", "9x8y7z"].join("");
    const dir = await project(CONFIG, `TOKEN=${secret}\n`);
    const t = io(dir, [secret]);
    expect(await runStackInit({ image: IMAGE }, t.io, { fetch: createFakeFetch(registry).fetch })).toBe(3);
    expect(t.err.join("")).toContain("expected one of docker, podman");
    expect(t.err.join("")).not.toContain(secret);
    const flag = io(dir);
    expect(
      await runStackInit({ yes: true, image: IMAGE, ollamaPort: secret }, flag.io, {
        fetch: createFakeFetch(registry).fetch,
      }),
    ).toBe(3);
    expect(flag.err.join("")).not.toContain(secret);
  });

  it("REQ-GEN-10/AC6: the engine is the one this machine has: Podman when only Podman answers", async () => {
    const dir = await project();
    const fake = createFakeFetch(registry);
    const onlyPodman = (cmd: string) =>
      Promise.resolve(cmd === "podman" ? "podman version 5.4.0" : undefined);
    expect(
      await runStackInit({ yes: true, image: IMAGE }, io(dir).io, {
        fetch: fake.fetch,
        versionExec: onlyPodman,
      }),
    ).toBe(0);
    const qajitsu = (parse(await readFile(join(dir, "compose.yaml"), "utf8")) as Compose).services["qajitsu"];
    expect(qajitsu?.["volumes"]).toContain(".:/work:Z");
  });
});

describe("qajitsu stack pull (REQ-GEN-10/AC3+AC4)", () => {
  const OLLAMA = "http://ollama:11434";
  const tags = (models: { name: string; digest: string }[]): Route => ({
    match: /^\/api\/tags$/,
    reply: jsonReply({
      models: models.map((m) => ({ name: m.name, digest: m.digest.replace("sha256:", "") })),
    }),
  });

  it("REQ-GEN-10/AC3: pulls every model and checks it against its pinned digest", async () => {
    let present: { name: string; digest: string }[] = [];
    const pulled: string[] = [];
    const fake = createFakeFetch([
      { match: /^\/api\/tags$/, reply: (r) => tags(present).reply(r) },
      {
        method: "POST",
        match: /^\/api\/pull$/,
        reply: (r) => {
          const name = (JSON.parse(r.body ?? "{}") as { model: string }).model;
          pulled.push(name);
          present = [...present, { name, digest: name === "qwen3:4b" ? dig("a") : dig("b") }];
          return new Response(`${JSON.stringify({ status: "success" })}\n`);
        },
      },
    ]);
    const t = io("/");
    const code = await runStackPull(
      { ollama: OLLAMA, models: [`qwen3:4b@${dig("a")}`, `nomic-embed-text:latest@${dig("b")}`] },
      t.io,
      { fetch: fake.fetch },
    );
    expect(t.err.join("")).toBe("");
    expect(code).toBe(0);
    expect(pulled).toEqual(["qwen3:4b", "nomic-embed-text:latest"]);
  });

  it("REQ-GEN-10/AC3: a pull that fails stops the stack with the model's name", async () => {
    const fake = createFakeFetch([
      tags([]),
      {
        method: "POST",
        match: /^\/api\/pull$/,
        reply: textReply(`${JSON.stringify({ error: "manifest unknown" })}\n`),
      },
    ]);
    const t = io("/");
    expect(
      await runStackPull({ ollama: OLLAMA, models: [`qwen3:4b@${dig("a")}`] }, t.io, { fetch: fake.fetch }),
    ).toBe(3);
    expect(t.err.join("")).toContain("Pulling qwen3:4b into Ollama failed: manifest unknown");
  });

  it("REQ-GEN-10/AC4: a model Ollama holds at another digest than the pinned one is refused, naming both", async () => {
    const fake = createFakeFetch([
      tags([{ name: "qwen3:4b", digest: dig("f") }]),
      {
        method: "POST",
        match: /^\/api\/pull$/,
        reply: textReply(`${JSON.stringify({ status: "success" })}\n`),
      },
    ]);
    const t = io("/");
    expect(
      await runStackPull({ ollama: OLLAMA, models: [`qwen3:4b@${dig("a")}`] }, t.io, { fetch: fake.fetch }),
    ).toBe(3);
    expect(t.err.join("")).toContain(
      `qwen3:4b has the digest ${dig("f")} in Ollama, the stack pins ${dig("a")}`,
    );
    // A model without a pinned digest is not pulled at all.
    const loose = io("/");
    expect(
      await runStackPull({ ollama: OLLAMA, models: ["qwen3:4b"] }, loose.io, { fetch: fake.fetch }),
    ).toBe(3);
    expect(loose.err.join("")).toContain("has no digest");
  });

  it("REQ-GEN-10/AC3: models already there at their digest are not pulled again on a later start", async () => {
    const fake = createFakeFetch([tags([{ name: "qwen3:4b", digest: dig("a") }])]);
    const t = io("/");
    expect(
      await runStackPull({ ollama: OLLAMA, models: [`qwen3:4b@${dig("a")}`] }, t.io, { fetch: fake.fetch }),
    ).toBe(0);
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
    expect(t.out.join("")).toContain("qwen3:4b: already there");
  });
});
