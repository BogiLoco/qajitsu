import type { Logger } from "@qajitsu/core";
import { pino } from "pino";

/**
 * Creates the CLI logger on pino; every field and message passes through `mask` first (invariant 8).
 *
 * @param options - Destination file (synchronous append), level and masker.
 */
export function createCliLogger(options: {
  readonly file: string;
  readonly level?: string;
  readonly mask: (value: unknown) => unknown;
}): Logger {
  const base = pino(
    { level: options.level ?? "info", base: null },
    pino.destination({ dest: options.file, sync: true, mkdir: true }),
  );
  const at =
    (level: "debug" | "info" | "warn" | "error") =>
    (fields: Readonly<Record<string, unknown>>, message: string): void => {
      base[level](options.mask(fields) as object, String(options.mask(message)));
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
