import { AdapterError } from "@qajitsu/core";
import { z } from "zod";
import type { CapabilityOverride, ModelProfile, TokenPrice } from "./capabilities.js";

/** Gateways QAJitsu reads model profiles from (REQ-LLM-10). */
export type GatewayKind = "litellm" | "openrouter";

/** What a gateway reports about one of its models; a field it does not report is left out. */
export interface GatewayModel {
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly structuredOutput?: boolean;
  readonly contextWindow?: number;
  readonly costPerMTok?: TokenPrice;
}

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});
/** A stored {@link GatewayModel}, checked when it is read back (REQ-LLM-10/AC3). */
export const GatewayModelSchema = z.strictObject({
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  costPerMTok: PriceSchema.optional(),
});
/** A stored {@link GatewayInfo}: kind, read time and its models as `[name, model]` pairs. */
export const StoredGatewaySchema = z.object({
  kind: z.enum(["litellm", "openrouter"]),
  readAt: z.iso.datetime(),
  models: z.array(z.tuple([z.string().min(1), GatewayModelSchema])).max(100_000),
});

/** A gateway's models as read at one time. */
export interface GatewayInfo {
  readonly kind: GatewayKind;
  /** ISO time of the read (REQ-LLM-10/AC3). */
  readonly readAt: string;
  readonly models: ReadonlyMap<string, GatewayModel>;
}

/** Where a capability of a profile came from (REQ-LLM-10/AC3). */
export type CapabilitySource = "config" | "gateway" | "built-in" | "unknown";

/** The capabilities `qj doctor --models` names a source for. */
export interface ProfileSources {
  readonly tools: CapabilitySource;
  readonly vision: CapabilitySource;
  readonly structuredOutput: CapabilitySource;
  readonly contextWindow: CapabilitySource;
  readonly price: CapabilitySource;
}

/** Keeps gateway answers between commands; an answer older than {@link GATEWAY_MAX_AGE_MS} is read again. */
export interface GatewayCache {
  get(key: string): GatewayInfo | undefined;
  set(key: string, info: GatewayInfo): void;
}

/** How long a gateway's answer is used before it is read again. */
export const GATEWAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The largest gateway answer read: OpenRouter's whole list is about 1 MB. */
export const GATEWAY_MAX_BYTES = 16 * 1024 * 1024;

/** JSON of at most `limit` bytes, read as a stream; undefined when the body is larger, `null` when it is not JSON. */
async function readJsonAtMost(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return null;
  }
}

/** A cache for one process. */
export function memoryGatewayCache(): GatewayCache {
  const entries = new Map<string, GatewayInfo>();
  return { get: (key) => entries.get(key), set: (key, info) => void entries.set(key, info) };
}

const perToken = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
};
const price = (
  input: unknown,
  output: unknown,
  cached?: unknown,
  write?: unknown,
): TokenPrice | undefined => {
  const i = perToken(input);
  const o = perToken(output);
  if (i === undefined || o === undefined) return undefined;
  const c = perToken(cached);
  const w = perToken(write);
  return {
    input: i,
    output: o,
    ...(c === undefined ? {} : { cachedInput: c }),
    ...(w === undefined ? {} : { cacheWrite: w }),
  };
};
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
/** The fields a gateway reported; an undefined one is not reported. */
const defined = (o: Record<string, unknown>): GatewayModel =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const LiteLLMSchema = z.object({
  data: z.array(
    z.object({ model_name: z.string().min(1), model_info: z.record(z.string(), z.unknown()).nullish() }),
  ),
});

/**
 * LiteLLM's `/model/info` (REQ-LLM-10/AC1): each `model_name` with what its `model_info` states. A null or missing
 * field is not reported, so it stays unknown.
 *
 * @param body - The parsed answer.
 * @throws {AdapterError} `GATEWAY_ANSWER_INVALID` for an answer that is not LiteLLM's model info.
 */
export function parseLiteLLMModelInfo(body: unknown): Map<string, GatewayModel> {
  const parsed = LiteLLMSchema.safeParse(body);
  if (!parsed.success)
    throw new AdapterError("GATEWAY_ANSWER_INVALID", "The answer is not LiteLLM's model info.");
  const out = new Map<string, GatewayModel>();
  for (const m of parsed.data.data) {
    const i = m.model_info ?? {};
    const cost = price(
      i["input_cost_per_token"],
      i["output_cost_per_token"],
      i["cache_read_input_token_cost"],
      i["cache_creation_input_token_cost"],
    );
    out.set(
      m.model_name,
      defined({
        tools: bool(i["supports_function_calling"]),
        vision: bool(i["supports_vision"]),
        structuredOutput: bool(i["supports_response_schema"]),
        contextWindow: positive(i["max_input_tokens"]),
        costPerMTok: cost,
      }),
    );
  }
  return out;
}

const OpenRouterSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      context_length: z.unknown().optional(),
      pricing: z.record(z.string(), z.unknown()).nullish(),
      architecture: z.object({ input_modalities: z.array(z.string()).nullish() }).nullish(),
      supported_parameters: z.array(z.string()).nullish(),
    }),
  ),
});

/**
 * OpenRouter's `/models` (REQ-LLM-10/AC1): each model id with its context length, prices per token, whether its
 * parameters include tools and structured outputs, and whether it takes images.
 *
 * @param body - The parsed answer.
 * @throws {AdapterError} `GATEWAY_ANSWER_INVALID` for an answer that is not OpenRouter's model list.
 */
export function parseOpenRouterModels(body: unknown): Map<string, GatewayModel> {
  const parsed = OpenRouterSchema.safeParse(body);
  if (!parsed.success)
    throw new AdapterError("GATEWAY_ANSWER_INVALID", "The answer is not OpenRouter's model list.");
  const out = new Map<string, GatewayModel>();
  for (const m of parsed.data.data) {
    const params = m.supported_parameters;
    const modalities = m.architecture?.input_modalities;
    out.set(
      m.id,
      defined({
        tools: params ? params.includes("tools") : undefined,
        structuredOutput: params ? params.includes("structured_outputs") : undefined,
        vision: modalities ? modalities.includes("image") : undefined,
        contextWindow: positive(m.context_length),
        costPerMTok: price(
          m.pricing?.["prompt"],
          m.pricing?.["completion"],
          m.pricing?.["input_cache_read"],
          m.pricing?.["input_cache_write"],
        ),
      }),
    );
  }
  return out;
}

/**
 * Reads a gateway's models, or takes them from the cache when that answer is younger than a day (REQ-LLM-10/AC3).
 * The key is sent to the gateway's own address only and appears in no error (AC4).
 *
 * @param gateway - The provider's alias, kind, base URL (`.../v1`) and resolved key.
 * @param ports - Fetch, the cache and the clock.
 * @throws {AdapterError} `GATEWAY_UNAVAILABLE` or `GATEWAY_ANSWER_INVALID`.
 */
export async function readGateway(
  gateway: {
    readonly alias: string;
    readonly kind: GatewayKind;
    readonly baseUrl: string;
    readonly apiKey?: string | undefined;
  },
  ports: { readonly fetch: typeof globalThis.fetch; readonly cache: GatewayCache; readonly now: () => Date },
): Promise<GatewayInfo> {
  const base = gateway.baseUrl.replace(/\/+$/, "");
  const key = `${gateway.alias} ${gateway.kind} ${base}`;
  const cached = ports.cache.get(key);
  // An answer read in the future (a moved clock, an edited cache) is as stale as an old one.
  const age = cached ? ports.now().getTime() - Date.parse(cached.readAt) : Number.NaN;
  if (cached && age >= 0 && age < GATEWAY_MAX_AGE_MS) return cached;
  // A key belongs in the header: an address with credentials or a query string is refused, never echoed.
  let parsedBase: URL | undefined;
  try {
    parsedBase = new URL(base);
  } catch {
    parsedBase = undefined;
  }
  const plain =
    parsedBase !== undefined &&
    /^https?:$/.test(parsedBase.protocol) &&
    parsedBase.username === "" &&
    parsedBase.password === "" &&
    parsedBase.search === "";
  if (!plain)
    throw new AdapterError(
      "GATEWAY_URL_INVALID",
      `The ${gateway.kind} gateway ${gateway.alias} needs a plain https or http address, without credentials or a query; the key goes in api_key.`,
      { provider: gateway.alias },
    );
  const url = gateway.kind === "litellm" ? `${base}/model/info` : `${base}/models`;
  const unavailable = (why: string) =>
    new AdapterError(
      "GATEWAY_UNAVAILABLE",
      `The ${gateway.kind} gateway ${gateway.alias} did not answer: ${why}.`,
      {
        provider: gateway.alias,
      },
    );
  let response: Response;
  try {
    response = await ports.fetch(url, {
      headers: {
        accept: "application/json",
        ...(gateway.apiKey === undefined ? {} : { authorization: `Bearer ${gateway.apiKey}` }),
      },
      signal: AbortSignal.timeout(15_000),
      // The key is for this address only: a redirect anywhere is no answer.
      redirect: "error",
    });
  } catch (error) {
    // Only the kind of failure (its name and code: refused, timed out, name not found), never the error's text, which
    // can quote the address.
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const code = typeof cause?.code === "string" && /^[A-Z_]+$/.test(cause.code) ? ` (${cause.code})` : "";
    throw unavailable(
      error instanceof Error
        ? `${error.name === "TimeoutError" ? "no answer within 15 s" : "the request failed"}${code}`
        : "the request failed",
    );
  }
  if (!response.ok) throw unavailable(`HTTP ${String(response.status)}`);
  const body = await readJsonAtMost(response, GATEWAY_MAX_BYTES);
  if (body === undefined)
    throw unavailable(`the answer is larger than ${String(GATEWAY_MAX_BYTES / 1024 / 1024)} MB`);
  const info: GatewayInfo = {
    kind: gateway.kind,
    readAt: ports.now().toISOString(),
    models: gateway.kind === "litellm" ? parseLiteLLMModelInfo(body) : parseOpenRouterModels(body),
  };
  ports.cache.set(key, info);
  return info;
}

/**
 * A model's profile with where each capability came from (REQ-LLM-10/AC2+AC3): the project's declared values win, then
 * what the gateway reports, then the built-in profile. A capability nobody states stays unknown (as not supported),
 * so a role that needs it is refused as in REQ-LLM-03/AC3.
 *
 * @param base - The built-in profile (`modelProfile` without overrides).
 * @param builtIn - Whether that profile is a real built-in entry, not the unknown default.
 * @param gateway - What the gateway reports, if anything.
 * @param declared - `models.providers.<alias>.models.<model>`.
 */
export function profileWithSources(
  base: ModelProfile,
  builtIn: boolean,
  gateway: GatewayModel | undefined,
  declared: CapabilityOverride | undefined,
): { profile: ModelProfile; sources: ProfileSources } {
  const pick = <T>(config: T | undefined, gw: T | undefined, own: T): [T, CapabilitySource] =>
    config !== undefined
      ? [config, "config"]
      : gw !== undefined
        ? [gw, "gateway"]
        : [own, builtIn ? "built-in" : "unknown"];
  const [tools, toolsFrom] = pick(declared?.tools, gateway?.tools, base.tools);
  const [vision, visionFrom] = pick(declared?.vision, gateway?.vision, base.vision);
  const [structuredOutput, structuredFrom] = pick(
    declared?.structured_output,
    gateway?.structuredOutput,
    base.structuredOutput,
  );
  const [contextWindow, contextFrom] = pick(
    declared?.context_window,
    gateway?.contextWindow,
    base.contextWindow,
  );
  const declaredPrice = declared?.cost_per_mtok
    ? {
        input: declared.cost_per_mtok.input,
        output: declared.cost_per_mtok.output,
        ...(declared.cost_per_mtok.cached_input === undefined
          ? {}
          : { cachedInput: declared.cost_per_mtok.cached_input }),
        ...(declared.cost_per_mtok.cache_write === undefined
          ? {}
          : { cacheWrite: declared.cost_per_mtok.cache_write }),
      }
    : undefined;
  const [costPerMTok, priceFrom] = pick<TokenPrice | undefined>(
    declaredPrice,
    gateway?.costPerMTok,
    base.costPerMTok,
  );
  return {
    profile: { ...base, tools, vision, structuredOutput, contextWindow, costPerMTok },
    sources: {
      tools: toolsFrom,
      vision: visionFrom,
      structuredOutput: structuredFrom,
      contextWindow: contextFrom,
      price: costPerMTok === undefined ? "unknown" : priceFrom,
    },
  };
}
