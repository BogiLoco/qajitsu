import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDotenv } from "@qajitsu/adapter-secrets-env";
import { ConfigError, QajitsuError, type ResolvedProject } from "@qajitsu/core";
import { MODEL_ROLES, ollamaPull, ollamaTags } from "@qajitsu/models";
import { createMasker } from "@qajitsu/steps";
import { renderStackCompose, STACK_ENGINES, STACK_GPUS, type StackPlan } from "../stack/compose.js";
import {
  PINNED_IMAGES,
  presetRoles,
  STACK_PRESETS,
  withTag,
  type PinnedModel,
  type StackPreset,
} from "../stack/images.js";
import { inspectModel, memoryEstimate, type ModelFacts } from "../stack/inspect.js";
import { patchProjectForStack, stackModels } from "../stack/project-patch.js";
import { parsePinnedImage, parsePinnedModel, resolveQajitsuImage } from "../stack/registry.js";
import { effectiveRoles, stackContextLength, stackRoleProblems } from "../stack/roles.js";
import { loadProject } from "../project.js";
import { qajitsuVersion, type VersionExec } from "../versions.js";
import type { CommandIO } from "./fetch.js";

/** Flags of `qajitsu stack init` (REQ-GEN-10/AC2). */
export interface StackInitOptions {
  readonly engine?: string | undefined;
  readonly preset?: string | undefined;
  /** `role=name[:tag][@sha256:...]`, repeatable; `default=` sets every role the preset does not name. */
  readonly model?: readonly string[] | undefined;
  readonly gpu?: string | undefined;
  readonly ollamaPort?: string | undefined;
  readonly chromaPort?: string | undefined;
  /** `ollama|chroma|home=<volume name or host path>`, repeatable. */
  readonly volume?: readonly string[] | undefined;
  /** The QAJitsu image by digest, instead of the release image of this CLI's version. */
  readonly image?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly force?: boolean | undefined;
}

/** What `stack init` needs from outside. */
export interface StackPorts {
  readonly fetch: typeof globalThis.fetch;
  readonly versionExec?: VersionExec | undefined;
  readonly project?: ResolvedProject | undefined;
  /** Replaced only by tests that prove a leaking renderer is caught (REQ-GEN-10/AC5). */
  readonly render?: ((plan: StackPlan) => string) | undefined;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const oneOf = <T extends string>(
  name: string,
  value: string,
  allowed: readonly T[],
  mask: (t: string) => string,
): T => {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(
    "STACK_OPTION_INVALID",
    `--${name} ${mask(value)}: expected one of ${allowed.join(", ")}.`,
  );
};

const port = (name: string, value: string, mask: (t: string) => string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new ConfigError(
      "STACK_OPTION_INVALID",
      `--${name} ${mask(value)}: expected a port between 1 and 65535.`,
    );
  return n;
};

/** A volume name or a host path; never the host's root, the engine's socket, or anything with `:`. */
const SAFE_VOLUME = /^[A-Za-z0-9._~/-]+$/;
const FORBIDDEN_MOUNTS = /^(\/+|\/+var\/run(\/docker\.sock)?\/*|\/+run\/(podman|docker\.sock).*|.*\.sock)$/;

/** The engine on this machine: Podman when only Podman answers, Docker otherwise. */
const detectEngine = async (exec: VersionExec | undefined): Promise<(typeof STACK_ENGINES)[number]> => {
  if (!exec) return "docker";
  const [docker, podman] = await Promise.all([exec("docker", ["--version"]), exec("podman", ["--version"])]);
  return docker === undefined && podman !== undefined ? "podman" : "docker";
};

/**
 * `qajitsu stack init` (REQ-GEN-10/AC2..AC6): writes `compose.yaml` next to `.qa/` with QAJitsu, Ollama and, when the
 * knowledge base uses one, Chroma; every image and model pinned by digest; sets `models.roles` to the models the stack
 * pulls; refuses to write anything that holds a value of `.env.local`.
 *
 * @returns Exit code: 0 written, 3 on configuration errors or a refused write.
 */
export async function runStackInit(
  options: StackInitOptions,
  io: CommandIO,
  ports: StackPorts,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd, ports.project);
    // REQ-GEN-10/AC5, invariant 8: the values of .env.local never go into the stack's files, nor into a request.
    const envFile = join(project.projectDir, ".env.local");
    const masker = createMasker({
      secrets: Object.values((await exists(envFile)) ? parseDotenv(await readFile(envFile, "utf8")) : {}),
    });
    const refused = () =>
      new ConfigError(
        "STACK_SECRET_REFUSED",
        "The stack would hold a value of .env.local; nothing was written. Secrets reach the stack from .env.local at run time.",
      );
    if (
      [...(options.model ?? []), ...(options.volume ?? []), options.image ?? ""].some((v) =>
        masker.containsSecret(v),
      )
    )
      throw refused();
    const composeFile = join(project.projectDir, "compose.yaml");
    if ((await exists(composeFile)) && options.force !== true)
      throw new ConfigError("STACK_EXISTS", `${composeFile} exists; --force replaces it.`, {
        file: composeFile,
      });

    // An answer or option is echoed in an error only with the values of .env.local masked.
    const mask = (text: string) => masker.maskText(text);
    const ask = async (question: string, fallback: string): Promise<string> => {
      if (options.yes === true || !io.ask) return fallback;
      return (await io.ask(`${question} [${fallback}]: `)).trim() || fallback;
    };
    const engine = oneOf(
      "engine",
      await ask(
        `Container engine (${STACK_ENGINES.join("/")})`,
        options.engine ?? (await detectEngine(ports.versionExec)),
      ),
      STACK_ENGINES,
      mask,
    );
    const preset: StackPreset = oneOf(
      "preset",
      await ask(`Models (${STACK_PRESETS.join("/")})`, options.preset ?? "local"),
      STACK_PRESETS,
      mask,
    );
    const gpu = oneOf(
      "gpu",
      await ask(`GPU for Ollama (${STACK_GPUS.join("/")})`, options.gpu ?? "none"),
      STACK_GPUS,
      mask,
    );
    const ollamaPort = port(
      "ollama-port",
      await ask("Ollama port on this machine", options.ollamaPort ?? "11434"),
      mask,
    );
    const chromaPort = port("chroma-port", options.chromaPort ?? "8000", mask);

    // Roles: the preset, then --model role=name[@digest]. A digest given by hand is used as is.
    const roles = presetRoles(preset);
    const pinned = new Map<string, PinnedModel>();
    for (const entry of options.model ?? []) {
      const eq = entry.indexOf("=");
      if (eq <= 0)
        throw new ConfigError("STACK_OPTION_INVALID", `--model ${entry}: expected role=name[@sha256:...].`);
      const role = entry.slice(0, eq);
      if (role !== "default" && !(MODEL_ROLES as readonly string[]).includes(role))
        throw new ConfigError(
          "STACK_OPTION_INVALID",
          `--model ${role}=...: ${role} is no role; expected default or one of ${MODEL_ROLES.join(", ")}.`,
        );
      const value = entry.slice(eq + 1);
      const model = parsePinnedModel(value);
      roles[role] = model?.name ?? value;
      if (model) pinned.set(model.name, model);
    }
    if (preset === "hybrid")
      for (const role of ["planner", "author", "healer"])
        if (project.config.models.roles[role] === undefined && roles[role] === undefined)
          throw new ConfigError(
            "STACK_HYBRID_INCOMPLETE",
            `The hybrid preset keeps the project's cloud model for ${role}, and models.roles.${role} is not set; set it or choose another preset.`,
            { role },
          );

    const volumes = { ollama: "ollama", chroma: "chroma", home: "qajitsu-home" };
    for (const entry of options.volume ?? []) {
      const m = /^(ollama|chroma|home)=(.+)$/.exec(entry);
      if (!m?.[1] || !m[2])
        throw new ConfigError(
          "STACK_OPTION_INVALID",
          `--volume ${entry}: expected ollama|chroma|home=<name or path>.`,
        );
      if (!SAFE_VOLUME.test(m[2]) || FORBIDDEN_MOUNTS.test(m[2]) || m[2].split("/").includes(".."))
        throw new ConfigError(
          "STACK_OPTION_INVALID",
          `--volume ${entry}: a volume name or a path of letters, digits and . _ ~ / -, not the host's root or an engine socket.`,
        );
      volumes[m[1] as keyof typeof volumes] = m[2];
    }

    // An external Chroma stays where it is; the stack runs Chroma only for a knowledge base without a server.
    const chroma =
      project.config.knowledge.store === "chroma" && project.config.knowledge.chroma === undefined;
    const configFile = join(project.qaDir, "qa.project.yaml");
    const source = await readFile(configFile, "utf8");
    // What each model can do, from the registry: the roles are checked before anything is written.
    const facts = new Map<string, ModelFacts>();
    for (const name of stackModels(patchProjectForStack(source, { roles, chroma }))) {
      const found = await inspectModel(name, ports.fetch);
      facts.set(name, { ...found, digest: pinned.get(name)?.digest ?? found.digest });
    }
    const effective = effectiveRoles(project.config.models.roles, roles);
    const contextLength = stackContextLength(effective);
    const off = new Set([
      ...(project.config.verification.auditor === "off" ? ["auditor"] : []),
      ...(project.config.verification.triage === "off" ? ["triage"] : []),
    ]);
    const problems = stackRoleProblems({ roles: effective, facts, contextLength, off });
    if (problems.length > 0)
      throw new ConfigError(
        "STACK_ROLES_UNSERVED",
        `These roles cannot run on the stack's models:\n${problems.map((p) => `  - ${p}`).join("\n")}\nChoose a model with --model <role>=<name>, keep a configured cloud model for the role, or another preset.`,
        { problems },
      );
    const roleModels = new Set(Object.values(roles).map((m) => withTag(m)));
    const patched = patchProjectForStack(source, {
      roles,
      chroma,
      capabilities: Object.fromEntries(
        [...facts.values()]
          .filter((f) => roleModels.has(f.name))
          .map((f) => [
            f.name,
            { tools: f.tools, vision: f.vision, context_window: Math.min(f.contextWindow, contextLength) },
          ]),
      ),
    });
    const models: PinnedModel[] = [...facts.values()].map((f) => ({ name: f.name, digest: f.digest }));
    const qajitsu =
      options.image !== undefined
        ? parsePinnedImage(options.image)
        : await resolveQajitsuImage(qajitsuVersion(), ports.fetch);

    const plan: StackPlan = {
      project: project.config.project.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
      engine,
      gpu,
      ports: { ollama: ollamaPort, chroma: chromaPort },
      volumes,
      images: { qajitsu, ollama: PINNED_IMAGES.ollama, chroma: PINNED_IMAGES.chroma },
      models,
      chroma,
      contextLength,
    };
    const compose = (ports.render ?? renderStackCompose)(plan);

    // Whatever put it there, nothing written holds a value of .env.local.
    if (masker.containsSecret(compose) || masker.containsSecret(patched)) throw refused();

    // How much memory each model needs at the stack's context, against what the engine has (a warning, not a refusal).
    const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
    const needs = new Map(
      [...facts.values()].map((f) => [f.name, memoryEstimate(f, Math.min(f.contextWindow, contextLength))]),
    );
    const engineMemory = Number(
      (await ports.versionExec?.(
        engine,
        engine === "podman"
          ? ["info", "--format", "{{.Host.MemTotal}}"]
          : ["info", "--format", "{{.MemTotal}}"],
      )) ?? Number.NaN,
    );
    const largest = [...needs.entries()].reduce<[string, number] | undefined>(
      (max, [name, bytes]) =>
        bytes !== undefined && (max === undefined || bytes > max[1]) ? [name, bytes] : max,
      undefined,
    );

    await writeFile(composeFile, compose);
    await writeFile(configFile, patched);
    // Compose needs the file it names; an empty one, readable by its owner only, until secrets go into it. `wx` never
    // follows a file or link that appeared in between.
    const notes: string[] = [];
    let createdEnv = false;
    try {
      await writeFile(envFile, "", { mode: 0o600, flag: "wx" });
      createdEnv = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const mode = (await stat(envFile)).mode;
      if (process.platform !== "win32" && (mode & 0o077) !== 0)
        notes.push(
          `Warning: ${envFile} can be read by other users (mode ${(mode & 0o777).toString(8)}); fix: chmod 600 ${envFile}`,
        );
    }
    const gitignore = await readFile(join(project.projectDir, ".gitignore"), "utf8").catch(() => "");
    if (!/^\s*\/?\.env(\.local|\.\*|\*)?\s*$/m.test(gitignore))
      notes.push(`Warning: .gitignore does not exclude .env.local; add it before a secret goes in there.`);
    io.write(
      [
        `Wrote ${composeFile} (${engine}${gpu === "none" ? "" : `, ${gpu} GPU`}) and models.roles in ${configFile}.`,
        `  qajitsu  ${qajitsu.repository}@${qajitsu.digest}`,
        `  ollama   ${PINNED_IMAGES.ollama.repository}:${PINNED_IMAGES.ollama.version}${chroma ? `\n  chroma   ${PINNED_IMAGES.chroma.repository}:${PINNED_IMAGES.chroma.version}` : ""}`,
        ...models.map((m) => {
          const need = needs.get(m.name);
          return `  model    ${m.name}@${m.digest.slice(0, 19)}${need === undefined ? "" : `  needs about ${gb(need)}`}`;
        }),
        ...(largest !== undefined &&
        Number.isFinite(engineMemory) &&
        engineMemory > 0 &&
        largest[1] > engineMemory
          ? [
              `Warning: ${largest[0]} needs about ${gb(largest[1])} at ${String(contextLength)} tokens and ${engine} has ${gb(engineMemory)}: give the engine more memory or choose a smaller preset (docs/guides/stack.md).`,
            ]
          : []),
        ...(createdEnv ? [`Created an empty ${envFile} (0600) for the stack's secrets.`] : []),
        ...notes,
        "Next:",
        `  ${engine} compose up -d --wait            pulls the models once, then waits for them`,
        `  ${engine} compose run --rm qajitsu init ${plan.project} --yes --qa-dir .qa   once: the project in the stack's home`,
        `  ${engine} compose run --rm qajitsu doctor`,
        `  ${engine} compose run --rm qajitsu run <TICKET>`,
        "Check the image first: docs/releasing.md, 'Checking an image' (cosign verify).",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    if (error instanceof QajitsuError) {
      io.writeError(`${error.message}\n`);
      return 3;
    }
    throw error;
  }
}

/**
 * `qajitsu stack pull` (REQ-GEN-10/AC3+AC4), the stack's one-shot `models` step: pulls every model into Ollama and
 * checks that Ollama then holds it at the pinned digest. A model already there at that digest is not pulled again.
 *
 * @param options - The Ollama server and the models, each `name:tag@sha256:...`.
 * @returns Exit code: 0 every model is there at its digest, 3 when a model could not be pulled or has another digest.
 */
export async function runStackPull(
  options: { readonly ollama: string; readonly models: readonly string[] },
  io: CommandIO,
  ports: { readonly fetch: typeof globalThis.fetch },
): Promise<number> {
  try {
    const wanted = options.models.map((m) => {
      const pinned = parsePinnedModel(m);
      if (!pinned)
        throw new ConfigError(
          "STACK_MODEL_NOT_PINNED",
          `${m} has no digest; the stack pulls models by name@sha256.`,
        );
      return pinned;
    });
    const held = () => ollamaTags(options.ollama, ports.fetch);
    let present = await held();
    for (const model of wanted) {
      if (present.some((p) => p.name === model.name && p.digest === model.digest)) {
        io.write(`${model.name}: already there\n`);
        continue;
      }
      io.write(`${model.name}: pulling\n`);
      await ollamaPull(options.ollama, model.name, ports.fetch);
      present = await held();
      const got = present.find((p) => p.name === model.name);
      if (got?.digest !== model.digest)
        throw new ConfigError(
          "STACK_MODEL_DIGEST",
          `${model.name} has the digest ${got?.digest ?? "(not listed)"} in Ollama, the stack pins ${model.digest}; re-run qajitsu stack init to move the pin.`,
          { model: model.name },
        );
      io.write(`${model.name}: ${model.digest}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof QajitsuError) {
      io.writeError(`${error.message}\n`);
      return 3;
    }
    throw error;
  }
}
