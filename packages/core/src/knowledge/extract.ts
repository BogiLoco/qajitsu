import { inflateRawSync } from "node:zlib";
import { extname } from "node:path";
import { parse } from "yaml";

/** Document formats the knowledge base reads (REQ-KNOW-02/AC2). */
export type DocumentFormat = "markdown" | "text" | "html" | "openapi" | "docx";

/** A section of a document: heading path and text. */
export interface DocumentSection {
  readonly section: string;
  readonly text: string;
}

/** Text extracted from a file, or why it was skipped. */
export type Extracted =
  | { readonly ok: true; readonly format: DocumentFormat; readonly sections: readonly DocumentSection[] }
  | { readonly ok: false; readonly reason: string };

/** Files that are never indexed, whatever the include globs say (REQ-KNOW-09/AC1). */
const NEVER_INDEXED = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|gpg|asc)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|\/)credentials(\.json)?$/i,
];

/**
 * Whether a file must never be indexed: environment files, keys and certificates, credential stores
 * (REQ-KNOW-09/AC1).
 *
 * @param path - Path relative to the source root, with `/` separators.
 */
export function isNeverIndexed(path: string): boolean {
  return NEVER_INDEXED.some((re) => re.test(path));
}

/** Credential shapes masked in document text before chunking and embedding (REQ-KNOW-09/AC1). */
const CREDENTIALS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
];
const ASSIGNED =
  /\b(password|passwd|pwd|secret|api[_-]?key|token|client[_-]?secret)(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi;

/**
 * Masks credential-shaped values: private keys, provider tokens, JWTs, bearer headers and `password: ...`
 * assignments (REQ-KNOW-09/AC1). Registered secret values are masked separately by the project's masker.
 *
 * @param text - Document text.
 */
export function maskCredentials(text: string): string {
  let out = text;
  for (const re of CREDENTIALS)
    out = out.replace(re, (m) => (/^(Bearer|Basic)\s/.test(m) ? `${m.split(/\s+/)[0] ?? ""} ***` : "***"));
  return out.replace(ASSIGNED, (_m, key: string, sep: string, q: string) => `${key}${sep}${q}***${q}`);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** HTML to Markdown-like text: headings become `#` lines, scripts, styles and tags are dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_m, n: string, t: string) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n`,
      )
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits Markdown into sections by headings; the section is the heading path (`A > B`). */
export function markdownSections(text: string): DocumentSection[] {
  const out: DocumentSection[] = [];
  const path: string[] = [];
  let buffer: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const body = buffer.join("\n").trim();
    if (body !== "") out.push({ section: path.filter(Boolean).join(" > "), text: body });
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      const level = heading[1].length;
      path.length = level - 1;
      path[level - 1] = heading[2];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/** One section per OpenAPI operation, e.g. `POST /orders` (REQ-KNOW-02/AC2). */
export function openApiSections(spec: Record<string, unknown>): DocumentSection[] {
  const out: DocumentSection[] = [];
  const paths = (spec["paths"] ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op === undefined || op === null || typeof op !== "object") continue;
      out.push({
        section: `${method.toUpperCase()} ${path}`,
        text: `${method.toUpperCase()} ${path}\n${JSON.stringify(op, null, 2)}`,
      });
    }
  }
  const info = spec["info"] as Record<string, unknown> | undefined;
  if (info) out.unshift({ section: "info", text: JSON.stringify(info, null, 2) });
  return out;
}

/** Entry names and contents of a ZIP archive (stored and deflated entries only). */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return files;
  const entries = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && p + 46 <= bytes.length; n++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(p + 10);
    const size = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    const name = bytes.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(dataStart, dataStart + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Text of a DOCX file as Markdown: paragraphs, with `Heading N` styles as headings. */
export function docxToText(bytes: Buffer): string | undefined {
  const xml = unzip(bytes).get("word/document.xml")?.toString("utf8");
  if (xml === undefined) return undefined;
  const lines: string[] = [];
  for (const para of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const text = decodeEntities(
      (para.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>|<w:tab\/>/g) ?? [])
        .map((t) => (t === "<w:tab/>" ? "\t" : t.replace(/<[^>]+>/g, "")))
        .join(""),
    );
    if (text.trim() === "") continue;
    const level = /<w:pStyle w:val="(?:Heading|heading)\s?(\d)"/.exec(para)?.[1];
    lines.push(level === undefined ? text : `${"#".repeat(Number(level))} ${text}`);
  }
  return lines.join("\n\n");
}

const isOpenApi = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  ("openapi" in value || "swagger" in value) &&
  "paths" in value;

/**
 * Extracts sections from a file by its extension (REQ-KNOW-02/AC2): Markdown, text, HTML, DOCX, and YAML or JSON
 * OpenAPI documents split per operation. PDF and other formats are skipped with the reason.
 *
 * @param path - File path (used for the extension only).
 * @param bytes - File content.
 */
export function extractDocument(path: string, bytes: Buffer): Extracted {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
    case ".mdx":
      return { ok: true, format: "markdown", sections: markdownSections(bytes.toString("utf8")) };
    case ".txt":
    case ".rst":
    case ".adoc":
      return { ok: true, format: "text", sections: markdownSections(bytes.toString("utf8")) };
    case ".html":
    case ".htm":
      return { ok: true, format: "html", sections: markdownSections(htmlToText(bytes.toString("utf8"))) };
    case ".docx": {
      const text = docxToText(bytes);
      return text === undefined
        ? { ok: false, reason: "not a readable DOCX file" }
        : { ok: true, format: "docx", sections: markdownSections(text) };
    }
    case ".yaml":
    case ".yml":
    case ".json": {
      let value: unknown;
      try {
        value = ext === ".json" ? JSON.parse(bytes.toString("utf8")) : parse(bytes.toString("utf8"));
      } catch {
        return { ok: false, reason: "not valid YAML or JSON" };
      }
      return isOpenApi(value)
        ? { ok: true, format: "openapi", sections: openApiSections(value) }
        : { ok: false, reason: "only OpenAPI documents are read from YAML and JSON" };
    }
    case ".pdf":
      return { ok: false, reason: "PDF text extraction is not supported yet" };
    default:
      return { ok: false, reason: `unsupported format ${ext === "" ? "(no extension)" : ext}` };
  }
}

/** Upper size of one chunk in characters. */
export const CHUNK_CHARS = 1_500;

/**
 * Splits sections into chunks of at most {@link CHUNK_CHARS} characters at paragraph, then line boundaries; each
 * chunk keeps its section (REQ-KNOW-02/AC5).
 */
export function chunkSections(sections: readonly DocumentSection[], max = CHUNK_CHARS): DocumentSection[] {
  const out: DocumentSection[] = [];
  for (const { section, text } of sections) {
    let current = "";
    const push = (): void => {
      if (current.trim() !== "") out.push({ section, text: current.trim() });
      current = "";
    };
    for (const para of text.split(/\n{2,}/)) {
      const pieces =
        para.length <= max ? [para] : (para.match(new RegExp(`[\\s\\S]{1,${String(max)}}`, "g")) ?? []);
      for (const piece of pieces) {
        if (current.length + piece.length + 2 > max) push();
        current = current === "" ? piece : `${current}\n\n${piece}`;
      }
    }
    push();
  }
  return out;
}
