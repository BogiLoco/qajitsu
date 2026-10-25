import { createHash } from "node:crypto";

/**
 * Files of web cases (REQ-EXEC-38): types by name, files generated from the plan, and what a downloaded file holds.
 * Pure helpers of the trusted runtime; specs never reach them.
 */

const TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

/** The MIME type of a file name, by its extension. */
export const mimeOf = (name: string): string =>
  TYPES[/\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Whether content of this type is text QAJitsu can read and mask as it is. */
export const isTextType = (type: string): boolean =>
  type.startsWith("text/") ||
  type === "application/json" ||
  type === "application/xml" ||
  type.endsWith("+xml");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** A valid 1×1 PNG, padded with an ancillary chunk to `bytes` when that is larger. */
function png(bytes: number): Uint8Array {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ihdr = chunk("IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0));
  // zlib stream of one row (filter byte and one transparent RGBA pixel) as a stored block, with its Adler-32.
  const idat = chunk(
    "IDAT",
    Uint8Array.of(0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05, 0x00, 0x01),
  );
  const iend = chunk("IEND", new Uint8Array());
  const base = signature.length + ihdr.length + idat.length + iend.length;
  const pad =
    bytes > base + 12 ? chunk("qaJp", new Uint8Array(bytes - base - 12).fill(0x71)) : new Uint8Array();
  const out = new Uint8Array(base + pad.length);
  let at = 0;
  for (const part of [signature, ihdr, idat, pad, iend]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The bytes of a file the plan describes by name, type and size (REQ-EXEC-38/AC1): deterministic, so a run can be
 * repeated; a PNG is a real image, text types are readable lines, anything else repeated bytes.
 */
export function generateFile(spec: {
  readonly name: string;
  readonly type: string;
  readonly bytes: number;
}): Uint8Array {
  if (spec.type === "image/png") return png(spec.bytes);
  if (isTextType(spec.type)) {
    const line = new TextEncoder().encode(`QAJitsu test file ${spec.name}\n`);
    const out = new Uint8Array(spec.bytes);
    for (let i = 0; i < out.length; i += 1) out[i] = line[i % line.length] ?? 0x20;
    return out;
  }
  return new Uint8Array(spec.bytes).fill(0x71);
}

/** Data rows of CSV text, header excluded; quoted fields with line breaks count as one row. */
export function csvRows(text: string): number {
  let rows = 0;
  let quoted = false;
  let content = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === "\n" && !quoted) {
      if (content) rows += 1;
      content = false;
    } else if (ch !== "\r") content = true;
  }
  if (content) rows += 1;
  return Math.max(0, rows - 1);
}

/** What a step downloaded, as the runtime keeps it for `download.*` checks. */
export interface DownloadedFile {
  readonly name: string;
  readonly type: string;
  readonly data: Uint8Array;
  /** The text of the file: as it is for text types, extracted for PDF and XLSX; undefined when unreadable. */
  readonly text?: string | undefined;
}

/** SHA-256 of a download, hex. */
export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
