import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ConfigError,
  QajitsuError,
  readKnowledgeIndex,
  readKnowledgeSources,
  writeKnowledgeSources,
  type Embedder,
  type KnowledgeSource,
  type VectorStore,
} from "@qajitsu/core";
import { createEmbedder } from "@qajitsu/models";
import { createMasker, type Masker } from "@qajitsu/steps";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { syncKnowledge, type KnowledgeContext, type SyncReport } from "../knowledge/engine.js";
import { loadProject, type LoadedProject } from "../project.js";
import { registerConfiguredSecrets } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Replaceable parts of the knowledge commands (tests use a fake embedder). */
export interface KnowledgePorts {
  /** Opens the store of a project's knowledge folder; default: LanceDB (ADR-0007). */
  readonly knowledgeStore?: (dir: string, project: LoadedProject) => Promise<VectorStore>;
  /** Builds the embedding model `<provider>/<model>`; default: the models layer. */
  readonly embedder?: (reference: string, project: LoadedProject) => Promise<Embedder>;
}

type Ports = RuntimePorts & KnowledgePorts;

interface Opened extends KnowledgeContext {
  readonly project: LoadedProject;
  readonly slug: string;
  readonly masker: Masker;
}

/**
 * Opens the knowledge base of the resolved project (REQ-KNOW-01/AC1+AC3, REQ-KNOW-09/AC3): only
 * `<project-home>/knowledge/`, never another project's.
 */
async function open(io: CommandIO, ports: Ports, yes: boolean): Promise<Opened> {
  const project = await loadProject(io.cwd, ports.project);
  const resolved = project.project;
  if (!resolved)
    throw new ConfigError("PROJECT_NOT_SELECTED", "The knowledge base belongs to a project; select one.", {});
  const masker = createMasker();
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  await registerConfiguredSecrets(project, resolveSecret);
  const dir = resolved.paths.knowledge;
  const config = project.config.knowledge;
  let store: VectorStore;
  if (ports.knowledgeStore) store = await ports.knowledgeStore(dir, project);
  else if (config.store === "chroma")
    throw new ConfigError("KNOWLEDGE_STORE_UNAVAILABLE", "The chroma store is not available yet.", {});
  else store = await (await import("@qajitsu/adapter-knowledge-lancedb")).createLanceDbStore(dir);
  const consentFile = join(dir, "cloud-consent.json");
  return {
    project,
    slug: resolved.slug,
    masker,
    dir,
    store,
    config,
    now: ports.now,
    maskSecrets: (text) => masker.maskText(text),
    embedder: () =>
      ports.embedder
        ? ports.embedder(config.embedding, project)
        : createEmbedder(
            { config: project.config.models, resolveSecret, fetch: ports.fetch },
            config.embedding,
          ),
    confirmCloud: async (embedder) => {
      const given = await readFile(consentFile, "utf8").catch(() => "{}");
      if ((JSON.parse(given) as { embedding?: string }).embedding === embedder.id) return;
      io.writeError(
        `Warning: document text of project ${resolved.slug} will be sent to ${embedder.id}, a cloud embedding model.\n`,
      );
      const ok = yes || /^y(es)?$/i.test(((await io.ask?.("Send it? [y/N] ")) ?? "").trim());
      if (!ok)
        throw new ConfigError(
          "KNOWLEDGE_CLOUD_CONSENT",
          "Document text would leave the machine; confirm with --yes or use a local embedding model.",
          {},
        );
      await writeFile(
        consentFile,
        `${JSON.stringify({ embedding: embedder.id, at: ports.now().toISOString() })}\n`,
      );
    },
  };
}

const fail = (io: CommandIO, error: unknown, masker?: Masker): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  const text = `Error${code}: ${error instanceof Error ? error.message : String(error)}\n`;
  io.writeError(masker ? masker.maskText(text) : text);
  return 3;
};

/** Runs a knowledge command with an opened store, closing it afterwards; errors exit with 3. */
async function withKnowledge(
  io: CommandIO,
  ports: Ports,
  yes: boolean,
  fn: (k: Opened) => Promise<number>,
): Promise<number> {
  let k: Opened | undefined;
  try {
    k = await open(io, ports, yes);
    return await fn(k);
  } catch (error) {
    return fail(io, error, k?.masker);
  } finally {
    await k?.store.close();
  }
}

const n = (count: number, word: string): string => `${String(count)} ${word}`;

const printReport = (io: CommandIO, slug: string, r: SyncReport, dryRun = false): void => {
  const verb = dryRun ? "would be " : "";
  io.write(
    `Knowledge base of ${slug}: ${verb}${n(r.added.length, "added")}, ${verb}${n(r.updated.length, "updated")}, ` +
      `${n(r.unchanged.length, "unchanged")}, ${n(r.skipped.length, "skipped")}, ${verb}${n(r.removed.length, "removed")}` +
      ` · ${n(r.chunks, "chunk(s)")} · mode ${r.mode}${r.rebuilt ? " (rebuilt)" : ""}\n`,
  );
  if (dryRun) for (const p of [...r.added, ...r.updated]) io.write(`  would index ${p}\n`);
  for (const p of r.removed) io.write(`  ${dryRun ? "would remove" : "removed"} ${p}\n`);
  for (const s of r.skipped) io.write(`  skipped ${s.path}: ${s.reason}\n`);
};

const markSynced = async (k: Opened, names: readonly string[]): Promise<void> => {
  const at = k.now().toISOString();
  const sources = await readKnowledgeSources(k.dir);
  await writeKnowledgeSources(
    k.dir,
    sources.map((s) => (names.includes(s.name) ? { ...s, synced_at: at } : s)),
  );
};

const slugOf = (path: string): string =>
  basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 60) || "docs";

/**
 * `qajitsu knowledge add <path...>`: registers files and folders as sources and indexes them (REQ-KNOW-02,
 * REQ-KNOW-01/AC2 with `--qa-knowledge`). Adding a registered path again only processes new or changed files.
 *
 * @returns 0, or 3 on errors.
 */
export async function runKnowledgeAdd(
  paths: readonly string[],
  options: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
    readonly tag?: readonly string[] | undefined;
    readonly qaKnowledge?: boolean | undefined;
    readonly yes?: boolean | undefined;
  },
  io: CommandIO,
  ports: Ports,
): Promise<number> {
  return withKnowledge(io, ports, options.yes === true, async (k) => {
    const targets = [
      ...paths.map((p) => (isAbsolute(p) ? p : resolve(io.cwd, p))),
      ...(options.qaKnowledge === true ? [join(k.project.qaDir, "knowledge")] : []),
    ];
    if (targets.length === 0)
      throw new ConfigError("KNOWLEDGE_NOTHING_TO_ADD", "Give a path or --qa-knowledge.", {});
    const sources = await readKnowledgeSources(k.dir);
    const chosen: KnowledgeSource[] = [];
    for (const path of targets) {
      if (!(await stat(path).catch(() => undefined)))
        throw new ConfigError("KNOWLEDGE_SOURCE_MISSING", `${path} does not exist.`, {});
      const existing = sources.find((s) => s.path === path);
      if (existing) {
        const updated: KnowledgeSource = {
          ...existing,
          ...(options.include?.length ? { include: [...options.include] } : {}),
          ...(options.exclude?.length ? { exclude: [...options.exclude] } : {}),
          ...(options.tag?.length ? { tags: [...options.tag] } : {}),
        };
        sources[sources.indexOf(existing)] = updated;
        chosen.push(updated);
        continue;
      }
      const base = path === join(k.project.qaDir, "knowledge") ? "qa-knowledge" : slugOf(path);
      let name = base;
      for (let i = 2; sources.some((s) => s.name === name); i++) name = `${base}-${String(i)}`;
      const source: KnowledgeSource = {
        name,
        path,
        include: [...(options.include ?? [])],
        exclude: [...(options.exclude ?? [])],
        tags: [...(options.tag ?? [])],
        added_at: k.now().toISOString(),
      };
      sources.push(source);
      chosen.push(source);
    }
    await writeKnowledgeSources(k.dir, sources);
    const report = await syncKnowledge(k, chosen);
    await markSynced(
      k,
      chosen.map((s) => s.name),
    );
    printReport(io, k.slug, report);
    return 0;
  });
}

/**
 * `qajitsu knowledge sync [--dry-run]`: re-processes changed files of every source, removes chunks of deleted files
 * and adds new ones (REQ-KNOW-04/AC1+AC2).
 *
 * @returns 0, or 3 on errors.
 */
export async function runKnowledgeSync(
  options: { readonly dryRun?: boolean | undefined; readonly yes?: boolean | undefined },
  io: CommandIO,
  ports: Ports,
): Promise<number> {
  return withKnowledge(io, ports, options.yes === true, async (k) => {
    const sources = await readKnowledgeSources(k.dir);
    if (sources.length === 0) {
      io.write("The knowledge base has no sources: add documents with 'qajitsu knowledge add <path>'.\n");
      return 0;
    }
    const report = await syncKnowledge(k, sources, { dryRun: options.dryRun === true });
    if (options.dryRun !== true)
      await markSynced(
        k,
        sources.map((s) => s.name),
      );
    printReport(io, k.slug, report, options.dryRun === true);
    return 0;
  });
}

/**
 * `qajitsu knowledge reindex`: stores every chunk again with the configured embedding model and retrieval mode
 * (REQ-KNOW-08/AC2).
 *
 * @returns 0, or 3 on errors.
 */
export async function runKnowledgeReindex(
  options: { readonly yes?: boolean | undefined },
  io: CommandIO,
  ports: Ports,
): Promise<number> {
  return withKnowledge(io, ports, options.yes === true, async (k) => {
    const sources = await readKnowledgeSources(k.dir);
    printReport(io, k.slug, await syncKnowledge(k, sources, { rebuild: true }));
    return 0;
  });
}

/**
 * `qajitsu knowledge remove <source|file>`: deletes every chunk of a source (and the source) or of one file, which
 * is then excluded from its source (REQ-KNOW-03/AC1).
 *
 * @returns 0, or 3 on errors.
 */
export async function runKnowledgeRemove(target: string, io: CommandIO, ports: Ports): Promise<number> {
  return withKnowledge(io, ports, false, async (k) => {
    const sources = await readKnowledgeSources(k.dir);
    const files = await k.store.files();
    const source = sources.find((s) => s.name === target);
    if (source) {
      const deleted = await k.store.deleteFiles(
        files.filter((f) => f.source === source.name).map((f) => f.path),
      );
      await writeKnowledgeSources(
        k.dir,
        sources.filter((s) => s !== source),
      );
      io.write(`Removed source ${source.name} (${n(deleted, "chunk(s)")}).\n`);
      return 0;
    }
    const abs = isAbsolute(target) ? target : resolve(io.cwd, target);
    const owner = sources.find((s) => abs.startsWith(`${s.path}${sep}`) || abs === s.path);
    const display = owner
      ? `${owner.name}/${relative(owner.path, abs).split(sep).join("/") || basename(abs)}`
      : target;
    const file = files.find((f) => f.path === display || f.path === target);
    if (!file)
      throw new ConfigError(
        "KNOWLEDGE_NOT_FOUND",
        `'${target}' is neither a source nor an indexed file; see 'qajitsu knowledge list'.`,
        {},
      );
    const deleted = await k.store.deleteFiles([file.path]);
    const rel = file.path.slice(file.source.length + 1);
    await writeKnowledgeSources(
      k.dir,
      sources.map((s) =>
        s.name === file.source && !s.exclude.includes(rel) && rel !== basename(s.path)
          ? { ...s, exclude: [...s.exclude, rel] }
          : s,
      ),
    );
    io.write(
      `Removed ${file.path} (${n(deleted, "chunk(s)")}); it is excluded from source ${file.source}.\n`,
    );
    return 0;
  });
}

/**
 * `qajitsu knowledge reset`: empties the knowledge base after confirmation; `--keep-sources` keeps the registered
 * sources for a later `sync` (REQ-KNOW-03/AC2).
 *
 * @returns 0, or 3 when not confirmed or on errors.
 */
export async function runKnowledgeReset(
  options: { readonly keepSources?: boolean | undefined; readonly yes?: boolean | undefined },
  io: CommandIO,
  ports: Ports,
): Promise<number> {
  return withKnowledge(io, ports, false, async (k) => {
    const chunks = await k.store.count();
    if (options.yes !== true) {
      if (!io.ask)
        throw new ConfigError("CONFIRMATION_REQUIRED", "Not interactive: pass --yes to reset.", {});
      const answer = await io.ask(
        `Delete ${n(chunks, "chunk(s)")} of the knowledge base of ${k.slug}? [y/N] `,
      );
      if (!/^y(es)?$/i.test(answer.trim())) {
        io.writeError("Nothing deleted.\n");
        return 3;
      }
    }
    await k.store.reset();
    await rm(join(k.dir, "index.json"), { force: true });
    const sources = await readKnowledgeSources(k.dir);
    if (options.keepSources === true)
      await writeKnowledgeSources(
        k.dir,
        sources.map((s) => {
          const copy = { ...s };
          delete copy.synced_at;
          return copy;
        }),
      );
    else await rm(join(k.dir, "sources.yaml"), { force: true });
    io.write(
      `Knowledge base of ${k.slug} emptied (${n(chunks, "chunk(s)")} deleted)${options.keepSources === true ? `; ${n(sources.length, "source(s)")} kept, rebuild with 'qajitsu knowledge sync'` : ""}.\n`,
    );
    return 0;
  });
}

const dirSize = async (dir: string): Promise<number> => {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []))
    if (e.isFile()) total += (await stat(join(e.parentPath, e.name)).catch(() => ({ size: 0 }))).size;
  return total;
};

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/**
 * `qajitsu knowledge list`: sources with file and chunk counts, tags and last sync, plus the embedding model,
 * retrieval mode and size on disk (REQ-KNOW-05/AC1, REQ-KNOW-07/AC3).
 *
 * @returns 0, or 3 on errors.
 */
export async function runKnowledgeList(io: CommandIO, ports: Ports): Promise<number> {
  return withKnowledge(io, ports, false, async (k) => {
    const sources = await readKnowledgeSources(k.dir);
    const files = await k.store.files();
    const index = await readKnowledgeIndex(k.dir);
    if (sources.length === 0 && files.length === 0) {
      io.write(`Knowledge base of ${k.slug}: empty (add documents with 'qajitsu knowledge add <path>').\n`);
      return 0;
    }
    const chunks = files.reduce((t, f) => t + f.chunks, 0);
    io.write(
      `Knowledge base of ${k.slug}: ${n(sources.length, "source(s)")}, ${n(files.length, "file(s)")}, ${n(chunks, "chunk(s)")}` +
        ` · mode ${index?.mode ?? "not built"} · embedding ${index?.embedding ?? "none (full mode)"}` +
        ` · store ${k.config.store} · ${mb(await dirSize(k.dir))} on disk\n`,
    );
    for (const s of sources) {
      const own = files.filter((f) => f.source === s.name);
      io.write(
        `  ${s.name}  ${s.path}  ${n(own.length, "file(s)")}  ${n(
          own.reduce((t, f) => t + f.chunks, 0),
          "chunk(s)",
        )}  tags ${s.tags.join(",") || "-"}  last sync ${s.synced_at?.slice(0, 16).replace("T", " ") ?? "never"}\n`,
      );
    }
    return 0;
  });
}

/**
 * `qajitsu knowledge search "<query>"`: the ranked chunks agents would get, with source, section and date
 * (REQ-KNOW-05/AC2). Hybrid knowledge bases embed the query with the configured model.
 *
 * @returns 0, or 3 on errors.
 */
export async function runKnowledgeSearch(
  query: string,
  options: { readonly tag?: readonly string[] | undefined; readonly limit?: string | undefined },
  io: CommandIO,
  ports: Ports,
): Promise<number> {
  return withKnowledge(io, ports, false, async (k) => {
    const limit = Number(options.limit ?? "5");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new ConfigError("KNOWLEDGE_LIMIT_INVALID", "--limit must be 1 to 50.", {});
    const hits = await searchKnowledge(k, query, options.tag ?? [], limit);
    if (hits.length === 0) {
      io.write("No matching documentation.\n");
      return 0;
    }
    hits.forEach((h, i) => {
      const c = h.chunk;
      io.write(
        `${String(i + 1)}. ${c.path}${c.section ? ` › ${c.section}` : ""} (${c.modifiedAt.slice(0, 10)}) [${c.id}]\n` +
          `   ${c.text.replace(/\s+/g, " ").slice(0, 240)}\n`,
      );
    });
    return 0;
  });
}

/** Search as agents get it: hybrid with the index's embedding model, keyword-only in full mode. */
export async function searchKnowledge(
  k: Pick<KnowledgeContext, "dir" | "store" | "embedder" | "config">,
  query: string,
  tags: readonly string[],
  limit: number,
) {
  const index = await readKnowledgeIndex(k.dir);
  let vector: number[] | undefined;
  if (index?.mode === "hybrid") {
    if (index.embedding !== k.config.embedding)
      throw new ConfigError(
        "KNOWLEDGE_EMBEDDING_CHANGED",
        `The knowledge base was embedded with ${index.embedding ?? "another model"}; run 'qajitsu knowledge reindex'.`,
        {},
      );
    vector = (await (await k.embedder()).embed([query]))[0];
  }
  return k.store.search({
    text: query,
    limit,
    ...(tags.length ? { tags } : {}),
    ...(vector ? { vector } : {}),
  });
}
