import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** What code found in a repository that decides how it can be tested (REQ-GEN-13/AC1). */
export const FINDING_KINDS = [
  "web-framework",
  "web-pages",
  "android-project",
  "ios-project",
  "react-native",
  "flutter",
  "openapi",
  "graphql-sdl",
  "proto",
  "wsdl",
  "asyncapi",
  "compose",
  "playwright-tests",
  "cypress-tests",
  "appium-tests",
  "maestro-flows",
] as const;

/** One kind of {@link FINDING_KINDS}. */
export type FindingKind = (typeof FINDING_KINDS)[number];

/** A finding with the files it is based on (paths relative to the repository, `/`-separated). */
export interface Finding {
  /** `F1`, `F2`, ...: what recommendations cite. */
  readonly id: string;
  readonly kind: FindingKind;
  readonly files: readonly string[];
  /** Written by code, e.g. `react 18 in package.json`. */
  readonly detail: string;
}

/** What the scan looked at. */
export interface RepositoryScan {
  readonly findings: readonly Finding[];
  readonly files: number;
  /** True when the scan stopped at its limit: the findings are what it saw. */
  readonly truncated: boolean;
}

/** Folders of dependencies, builds and tools: never the application's own description. */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "vendor",
  "Pods",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".qa-runs",
  ".dart_tool",
  "DerivedData",
]);

const WEB_PACKAGES =
  /^(react|react-dom|vue|svelte|next|nuxt|@angular\/core|solid-js|astro|preact|lit|@remix-run\/react)$/;
const MAX_FILES_PER_FINDING = 10;
// eslint-disable-next-line no-control-regex -- control characters in a file name are exactly what is refused.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HEAD_BYTES = 2048;

/**
 * Opens a regular file for reading without following a link or blocking on a FIFO, and checks it is a regular file
 * on the handle itself, so a file swapped after it was listed is not read.
 */
async function openRegular(file: string): Promise<FileHandle | undefined> {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  ).catch(() => undefined);
  if (!handle) return undefined;
  const info = await handle.stat().catch(() => undefined);
  if (info?.isFile() === true) return handle;
  await handle.close();
  return undefined;
}

/** The first bytes of a file, as text; undefined when it cannot be read. */
async function head(file: string): Promise<string | undefined> {
  const handle = await openRegular(file);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** A file's text, when it is small enough to read whole (256 KB). */
async function whole(file: string): Promise<string | undefined> {
  const handle = await openRegular(file);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    if (size > 256 * 1024) return undefined;
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Walks a repository and finds by code what the application is and how it can be tested (REQ-GEN-13/AC1): web
 * front-ends, mobile projects (Gradle, Xcode, React Native, Flutter), API descriptions (OpenAPI, GraphQL SDL, `.proto`,
 * WSDL, AsyncAPI), compose files and existing test suites (Playwright, Cypress, Appium, Maestro). Only file names and
 * the first bytes of candidate files are read; dependency and build folders and symbolic links are skipped.
 *
 * @param root - The repository folder.
 * @param limits - At most this many files and this folder depth.
 */
export async function scanRepository(
  root: string,
  limits: {
    readonly maxFiles?: number;
    readonly maxDepth?: number;
    /**
     * The repository's own files (`git ls-files`, tracked and not ignored): build output and generated files are not
     * the application. Without it the folders are walked.
     */
    readonly tracked?: readonly string[] | undefined;
  } = {},
): Promise<RepositoryScan> {
  const maxFiles = limits.maxFiles ?? 20_000;
  const maxDepth = limits.maxDepth ?? 8;
  const files: string[] = [];
  const dirs: string[] = [];
  let truncated = false;
  if (limits.tracked !== undefined) {
    const seenDirs = new Set<string>();
    for (const rel of [...limits.tracked].sort()) {
      const parts = rel.split("/");
      // A name with control characters (a newline, an escape sequence) could forge terminal output: not looked at.
      if (
        parts.some((p) => SKIPPED.has(p) || p === ".." || p === "") ||
        parts.length - 1 > maxDepth ||
        CONTROL.test(rel)
      )
        continue;
      // A link could point outside the repository: only real files are looked at.
      const info = await lstat(join(root, rel)).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push(rel);
      for (let i = 1; i < parts.length; i += 1) seenDirs.add(parts.slice(0, i).join("/"));
    }
    dirs.push(...[...seenDirs].sort());
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // Folders count too: a tree of millions of empty folders ends the walk like many files do.
      if (files.length >= maxFiles || dirs.length >= maxFiles * 2) {
        truncated = true;
        return;
      }
      const path = join(dir, e.name);
      const rel = relative(root, path).split(sep).join("/");
      if (CONTROL.test(e.name)) continue;
      if (e.isDirectory()) {
        if (SKIPPED.has(e.name)) continue;
        dirs.push(rel);
        if (depth < maxDepth) await walk(path, depth + 1);
      } else if (e.isFile()) files.push(rel);
    }
  };
  if (limits.tracked === undefined) await walk(root, 0);

  const found = new Map<FindingKind, { files: string[]; details: string[] }>();
  const add = (kind: FindingKind, file: string, detail: string): void => {
    const f = found.get(kind) ?? { files: [], details: [] };
    if (!f.files.includes(file) && f.files.length < MAX_FILES_PER_FINDING) f.files.push(file);
    if (!f.details.includes(detail)) f.details.push(detail);
    found.set(kind, f);
  };
  const name = (p: string): string => p.split("/").at(-1) ?? p;

  for (const file of files) {
    const base = name(file);
    if (base === "package.json") {
      let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      try {
        pkg = JSON.parse((await whole(join(root, file))) ?? "") as typeof pkg;
      } catch {
        continue;
      }
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      for (const d of deps.filter((x) => WEB_PACKAGES.test(x))) add("web-framework", file, `${d} in ${file}`);
      if (deps.includes("react-native")) add("react-native", file, `react-native in ${file}`);
      if (deps.includes("@playwright/test")) add("playwright-tests", file, `@playwright/test in ${file}`);
      if (deps.includes("cypress")) add("cypress-tests", file, `cypress in ${file}`);
      for (const d of deps.filter((x) => x === "appium" || x === "webdriverio" || x.startsWith("@wdio/")))
        add("appium-tests", file, `${d} in ${file}`);
    } else if (/^playwright\.config\.(ts|js|mjs|cjs)$/.test(base)) add("playwright-tests", file, base);
    else if (/^cypress\.config\.(ts|js|mjs|cjs)$/.test(base)) add("cypress-tests", file, base);
    else if (/^wdio\.[\w.-]*conf\.(ts|js|mjs|cjs)$/.test(base)) add("appium-tests", file, base);
    else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) add("compose", file, `compose file ${file}`);
    else if (/\.html?$/.test(base)) add("web-pages", file, `HTML page ${file}`);
    else if (/\.(ejs|hbs|handlebars|pug|njk|jinja2?|erb|cshtml|razor)$|\.blade\.php$/.test(base))
      add("web-pages", file, `page template ${file}`);
    else if (/\.(m?js|cjs|ts|py|rb|go|java|kt|php)$/.test(base) && !/\.(test|spec)\.|\.d\.m?ts$/.test(base)) {
      // A server that answers with HTML pages is a web front-end too (server-rendered pages).
      const text = (await whole(join(root, file))) ?? "";
      if (/["'`]text\/html/i.test(text)) add("web-pages", file, `HTML served by ${file}`);
    } else if (base === "AndroidManifest.xml") add("android-project", file, file);
    else if (/^build\.gradle(\.kts)?$/.test(base)) {
      const text = (await head(join(root, file))) ?? "";
      if (/com\.android\.(application|library)/.test(text))
        add("android-project", file, `Android Gradle plugin in ${file}`);
    } else if (base === "Podfile") add("ios-project", file, file);
    else if (base === "pubspec.yaml") {
      const text = (await head(join(root, file))) ?? "";
      if (/^\s*flutter\s*:/m.test(text)) add("flutter", file, `Flutter in ${file}`);
    } else if (/\.(graphqls?|gql)$/.test(base)) add("graphql-sdl", file, `GraphQL schema ${file}`);
    else if (base.endsWith(".proto")) add("proto", file, `Protocol Buffers ${file}`);
    else if (base.endsWith(".wsdl")) add("wsdl", file, `WSDL ${file}`);
    else if (/\.(ya?ml|json)$/.test(base) && !file.includes("/.github/")) {
      const text = (await head(join(root, file))) ?? "";
      if (/(^|[{,])\s*["']?(openapi|swagger)["']?\s*:\s*["']?[23]\./m.test(text))
        add("openapi", file, `OpenAPI ${file}`);
      else if (/(^|[{,])\s*["']?asyncapi["']?\s*:/m.test(text)) add("asyncapi", file, `AsyncAPI ${file}`);
      else if (/(^|\/)\.maestro\//.test(file) && /^\s*appId\s*:/m.test(text))
        add("maestro-flows", file, `Maestro flow ${file}`);
    }
  }
  for (const dir of dirs) {
    const base = name(dir);
    if (/\.(xcodeproj|xcworkspace)$/.test(base)) add("ios-project", dir, dir);
  }

  const findings: Finding[] = [];
  for (const kind of FINDING_KINDS) {
    const f = found.get(kind);
    if (f)
      findings.push({
        id: `F${String(findings.length + 1)}`,
        kind,
        files: f.files,
        detail: f.details.slice(0, 3).join("; "),
      });
  }
  return { findings, files: files.length, truncated };
}
