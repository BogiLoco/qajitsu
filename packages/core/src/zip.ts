import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as used by ZIP. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a ZIP archive (deflate) from in-memory files; enough for OOXML documents such as `.xlsx`.
 *
 * @param files - Archive paths and contents, in order.
 */
export function zip(files: readonly { readonly name: string; readonly data: Uint8Array }[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

/**
 * Reads a ZIP archive (stored or deflated entries). Entry names that are absolute or contain `..` are
 * rejected, so an archive can never write outside its target folder (zip-slip).
 *
 * @param archive - ZIP bytes.
 * @returns Entries in archive order.
 * @throws {Error} For a malformed archive or an unsafe entry name.
 */
export function unzip(
  archive: Uint8Array,
  limits: {
    readonly maxEntries?: number;
    readonly maxEntryBytes?: number;
    readonly maxTotalBytes?: number;
  } = {},
): { name: string; data: Uint8Array }[] {
  const maxEntries = limits.maxEntries ?? 10_000;
  const maxEntryBytes = limits.maxEntryBytes ?? 500_000_000;
  const maxTotal = limits.maxTotalBytes ?? 2_000_000_000;
  let total = 0;
  const buf = Buffer.from(archive);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  const count = buf.readUInt16LE(end + 10);
  if (count > maxEntries)
    throw new Error(`ZIP has ${String(count)} entries, more than ${String(maxEntries)}`);
  let offset = buf.readUInt32LE(end + 16);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some((s) => s === ".."))
      throw new Error(`unsafe ZIP entry name '${name}'`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compressed);
    // Size limits stop zip bombs from filling the disk.
    const data =
      method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: maxEntryBytes }) : undefined;
    if (data === undefined) throw new Error(`unsupported ZIP compression method ${String(method)}`);
    if (data.byteLength > maxEntryBytes) throw new Error(`ZIP entry '${name}' is too large`);
    total += data.byteLength;
    if (total > maxTotal) throw new Error("ZIP content is too large");
    if (!name.endsWith("/")) out.push({ name, data: new Uint8Array(data) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
