import { gzipSync } from "node:zlib";

/** One 512-byte ustar header for a regular file. */
function header(path: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(path, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/**
 * A gzipped npm tarball (`package/<file>` entries) built in memory, for plugin install tests.
 *
 * @param files - Paths inside `package/` and their content; `package.json` is given as an object.
 */
export function npmTarball(files: Readonly<Record<string, string | object>>): Uint8Array {
  const parts: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
    parts.push(header(`package/${path}`, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}
