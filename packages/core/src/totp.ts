import { createHmac } from "node:crypto";
import { ConfigError } from "./errors.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Bytes of a base32 seed (RFC 4648), as authenticator apps show it: spaces, lower case and padding allowed. */
function base32(seed: string): Buffer {
  const clean = seed.replace(/[\s=]/g, "").toUpperCase();
  if (clean === "" || /[^A-Z2-7]/.test(clean))
    throw new ConfigError("TOTP_SEED_INVALID", "The value is not a base32 TOTP seed.", {});
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The time-based one-time code of a seed at a moment (RFC 6238, REQ-EXEC-55/AC1). Computed by trusted code from a
 * `secret://` seed; neither the seed nor the code is ever shown to an agent.
 *
 * @param seed - The base32 seed of the test account's authenticator.
 * @param timeMs - The moment, in milliseconds since the epoch (injected, so tests are deterministic).
 * @param options - Digits (6), period in seconds (30) and HMAC algorithm (SHA-1), as the application configures them.
 * @throws {ConfigError} `TOTP_SEED_INVALID` when the seed is not base32 (the seed itself is never in the error).
 */
export function totp(
  seed: string,
  timeMs: number,
  options: {
    readonly digits?: number;
    readonly period?: number;
    readonly algorithm?: "sha1" | "sha256" | "sha512";
  } = {},
): string {
  const digits = options.digits ?? 6;
  const counter = Math.floor(timeMs / 1000 / (options.period ?? 30));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(options.algorithm ?? "sha1", base32(seed))
    .update(message)
    .digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, "0");
}
