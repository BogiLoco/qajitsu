import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StoredGatewaySchema, type GatewayCache, type GatewayInfo, type GatewayModel } from "@qajitsu/models";

interface Stored {
  readonly kind: GatewayInfo["kind"];
  readonly readAt: string;
  readonly models: [string, GatewayModel][];
}

/**
 * A gateway cache in a JSON file of the project's home (REQ-LLM-10/AC3): each gateway's models with the time they were
 * read, so commands do not ask the gateway every time and `doctor` can say how old a profile is. It holds what the
 * gateway reported about its models, never a key. A file that cannot be read is an empty cache.
 *
 * @param file - e.g. `<project home>/cache/gateways.json`.
 */
export function fileGatewayCache(file: string): GatewayCache {
  let entries: Record<string, Stored> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") entries = parsed as Record<string, Stored>;
  } catch {
    entries = {};
  }
  return {
    get: (key) => {
      // Checked like any input: a cache entry is only used when it has the shape QAJitsu wrote.
      const e = StoredGatewaySchema.safeParse(Object.hasOwn(entries, key) ? entries[key] : undefined);
      if (!e.success) return undefined;
      return {
        kind: e.data.kind,
        readAt: e.data.readAt,
        models: new Map(e.data.models as [string, GatewayModel][]),
      };
    },
    set: (key, info) => {
      entries = {
        ...entries,
        [key]: { kind: info.kind, readAt: info.readAt, models: [...info.models.entries()] },
      };
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
      } catch {
        // A cache that cannot be written only means the gateway is asked again next time.
      }
    },
  };
}
