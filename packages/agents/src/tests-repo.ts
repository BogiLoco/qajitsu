import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { untrusted } from "./context.js";

/** What QAJitsu knows about the project's tests repository, computed by code from its worktree (REQ-CTX-06). */
export interface TestsRepoIndex {
  /** Test files and the titles of the tests in them (JS/TS `test`/`it`, Gherkin scenarios). */
  readonly tests: readonly { readonly file: string; readonly titles: readonly string[] }[];
  /** Page objects and helpers with the selectors they use. */
  readonly pageObjects: readonly { readonly file: string; readonly selectors: readonly string[] }[];
  /** How the repository locates elements, counted over its page objects and tests. */
  readonly selectorStrategy: {
    readonly preferred: "getByTestId" | "getByRole" | "getByLabel" | "getByText" | "css" | undefined;
    readonly counts: {
      readonly testId: number;
      readonly role: number;
      readonly label: number;
      readonly text: number;
      readonly css: number;
    };
  };
  /** Convention documents of the repository (README, CONTRIBUTING, testing guides), shortened. */
  readonly conventions: readonly { readonly file: string; readonly text: string }[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".venv",
]);
const TEST_FILE = /\.(spec|test|e2e)\.[cm]?[jt]sx?$|\.feature$/;
const PAGE_OBJECT =
  /(^|\/)(pages?|page-objects?|pom|components|helpers|support|fixtures)\/.*\.[cm]?[jt]sx?$|\.(page|po|component)\.[cm]?[jt]sx?$|Page\.[cm]?[jt]sx?$/;
const CONVENTION_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "TESTING.md",
  "docs/testing.md",
  "docs/conventions.md",
];
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TITLES = 200;
const MAX_SELECTORS = 60;
const MAX_CONVENTION_CHARS = 3000;

const JS_TITLE = /\b(?:test|it)(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(["'`])((?:\\.|(?!\1).)+)\1/g;
const GHERKIN_TITLE = /^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/gm;
const SELECTOR =
  /\b(getByTestId|getByRole|getByLabel|getByText|getByPlaceholder|locator)\((["'`])((?:\\.|(?!\2).)+)\2(\s*,\s*\{[^}]{0,120}\})?\)|data-testid=["']([\w:-]+)["']/g;

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
      } else if (e.isFile()) out.push(relative(root, abs).split("\\").join("/"));
      if (out.length >= MAX_FILES) return;
    }
  };
  await walk(root);
  return out;
}

const readSmall = async (file: string): Promise<string | undefined> => {
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Indexes the tests repository checked out for the run (REQ-CTX-06/AC2+AC3, REQ-EXEC-01/AC3): test titles per
 * file, page objects with their selectors, the selector strategy and the convention documents. Pure reading of the
 * worktree by code; symbolic links, vendored folders and large files are skipped.
 *
 * @param root - Worktree of the tests repository.
 */
export async function indexTestsRepo(root: string): Promise<TestsRepoIndex> {
  const tests: { file: string; titles: string[] }[] = [];
  const pageObjects: { file: string; selectors: string[] }[] = [];
  const counts = { testId: 0, role: 0, label: 0, text: 0, css: 0 };
  for (const file of await listFiles(root)) {
    const isTest = TEST_FILE.test(file);
    const isPage = !isTest && PAGE_OBJECT.test(file);
    if (!isTest && !isPage) continue;
    const text = await readSmall(join(root, file));
    if (text === undefined) continue;
    const selectors: string[] = [];
    for (const m of text.matchAll(SELECTOR)) {
      const kind = m[1] ?? "data-testid";
      if (kind === "getByTestId" || kind === "data-testid") counts.testId += 1;
      else if (kind === "getByRole") counts.role += 1;
      else if (kind === "getByLabel" || kind === "getByPlaceholder") counts.label += 1;
      else if (kind === "getByText") counts.text += 1;
      else counts.css += 1;
      if (isPage && selectors.length < MAX_SELECTORS) selectors.push(m[0]);
    }
    if (isPage && selectors.length > 0) pageObjects.push({ file, selectors });
    if (isTest) {
      const titles = file.endsWith(".feature")
        ? [...text.matchAll(GHERKIN_TITLE)].map((m) => m[1] ?? "")
        : [...text.matchAll(JS_TITLE)].map((m) => m[2] ?? "");
      if (titles.length > 0) tests.push({ file, titles: titles.slice(0, MAX_TITLES) });
    }
  }
  const ranked = (
    [
      ["getByTestId", counts.testId],
      ["getByRole", counts.role],
      ["getByLabel", counts.label],
      ["getByText", counts.text],
      ["css", counts.css],
    ] as const
  ).filter(([, n]) => n > 0);
  const preferred = [...ranked].sort((a, b) => b[1] - a[1])[0]?.[0];
  const conventions: { file: string; text: string }[] = [];
  for (const file of CONVENTION_DOCS) {
    const text = await readSmall(join(root, file));
    if (text !== undefined && text.trim() !== "")
      conventions.push({ file, text: text.slice(0, MAX_CONVENTION_CHARS) });
  }
  return { tests, pageObjects, selectorStrategy: { preferred, counts }, conventions };
}

const MAX_RENDER = 20_000;

/**
 * Renders the index for a prompt, bounded and wrapped as untrusted data (REQ-CTX-05/AC6): the repository's tests,
 * page objects and conventions are written by people and may contain anything.
 *
 * @param alias - Repository alias.
 * @param index - The index.
 */
export function renderTestsRepo(alias: string, index: TestsRepoIndex): string {
  const lines: string[] = [];
  const { preferred, counts } = index.selectorStrategy;
  if (preferred)
    lines.push(
      `Preferred selectors: ${preferred} (testId ${String(counts.testId)}, role ${String(counts.role)}, label ${String(counts.label)}, text ${String(counts.text)}, css ${String(counts.css)})`,
    );
  lines.push("", "Existing tests (file: titles):");
  let shown = 0;
  for (const t of index.tests) {
    const line = `- ${t.file}: ${t.titles.map((x) => JSON.stringify(x)).join(", ")}`;
    if (lines.join("\n").length + line.length > MAX_RENDER * 0.6) break;
    lines.push(line);
    shown += 1;
  }
  if (shown < index.tests.length)
    lines.push(`(${String(index.tests.length - shown)} more test files not listed)`);
  if (index.pageObjects.length > 0) {
    lines.push("", "Page objects and helpers (file: selectors):");
    for (const p of index.pageObjects) {
      const line = `- ${p.file}: ${p.selectors.join("; ")}`;
      if (lines.join("\n").length + line.length > MAX_RENDER * 0.85) break;
      lines.push(line);
    }
  }
  for (const c of index.conventions) {
    const block = `\n${c.file}:\n${c.text}`;
    if (lines.join("\n").length + block.length > MAX_RENDER) break;
    lines.push(block);
  }
  return untrusted(`tests-repo.${alias}`, lines.join("\n"));
}
