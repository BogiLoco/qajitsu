import type { JSONValue } from "ai";
import type { ModelProfile } from "./capabilities.js";

/**
 * What the context manager needs to know about a model (REQ-LLM-15): how much input works well, how much space the
 * answer needs, how much to add to an estimate because tokenisers differ, how tokens are counted, how the provider
 * caches a prompt, and whether the model wants a compact style. The manager never names a model (INV-11).
 */
export interface ContextProfile {
  /** Version of the profile table; part of every context snapshot (REQ-CTX-17/AC3). */
  readonly version: string;
  readonly window: number;
  /** Input that still works well: below the window, because long contexts lower quality (AC1). */
  readonly workingRange: number;
  /** Tokens kept free for the answer. */
  readonly answerReserve: number;
  /** Factor applied to the local estimate (four characters per token) for this model family (AC2). */
  readonly margin: number;
  /** `provider`: the provider counts before sending (near the budget); `estimate`: the local estimate only. */
  readonly counting: "provider" | "estimate";
  /** `explicit` cache breakpoints (Anthropic), a cached stable `prefix` (OpenAI, Google), or `none` (local). */
  readonly cache: "explicit" | "prefix" | "none";
  /** `compact` for small models: fewer fragments at once, the rest behind handles (AC4). */
  readonly style: "full" | "compact";
  /** The project's shares of the budget per fragment kind (REQ-CTX-14/AC1, `models.context_shares`), if any. */
  readonly shares?: Readonly<Record<string, number>>;
}

/** Version of {@link FAMILY}; raise it when a value changes, so snapshots name the profile they used. */
export const CONTEXT_PROFILE_VERSION = "2026-10-29.1";

/**
 * Defaults per provider type (AC1, AC2, AC3). Shares of the window are conservative where models are known to lose
 * quality on long inputs; a benchmark (REQ-LLM-06) can set a model's `working_range` in the project config instead.
 */
const FAMILY: Readonly<
  Record<
    string,
    Omit<ContextProfile, "version" | "window" | "workingRange" | "answerReserve"> & {
      share: number;
      reserve: number;
    }
  >
> = {
  // Newer Claude models count the same text as about 30% more tokens than the four-character estimate.
  anthropic: {
    share: 0.75,
    reserve: 8_192,
    margin: 1.35,
    counting: "provider",
    cache: "explicit",
    style: "full",
  },
  openai: { share: 0.6, reserve: 8_192, margin: 1.1, counting: "estimate", cache: "prefix", style: "full" },
  google: { share: 0.5, reserve: 8_192, margin: 1.15, counting: "estimate", cache: "prefix", style: "full" },
  ollama: { share: 0.8, reserve: 2_048, margin: 1.2, counting: "estimate", cache: "none", style: "compact" },
  "openai-compatible": {
    share: 0.7,
    reserve: 4_096,
    margin: 1.2,
    counting: "estimate",
    cache: "none",
    style: "full",
  },
  mock: { share: 0.75, reserve: 4_096, margin: 1, counting: "estimate", cache: "none", style: "full" },
};

const OTHER = FAMILY["openai-compatible"];

/**
 * The context profile of a model: the defaults of its provider type, the window from its capability profile, and the
 * project's overrides (`working_range`, `style`, `context_shares`). Small windows (below 64k tokens) get the compact style.
 *
 * @param providerType - The provider's type, e.g. `anthropic` or `ollama`.
 * @param profile - The model's capability profile.
 * @param overrides - Values from the project config.
 */
export function contextProfile(
  providerType: string,
  profile: Pick<ModelProfile, "contextWindow">,
  overrides: {
    readonly workingRange?: number | undefined;
    readonly style?: "full" | "compact" | undefined;
    readonly shares?: Readonly<Record<string, number>> | undefined;
  } = {},
): ContextProfile {
  const f = FAMILY[providerType] ??
    OTHER ?? {
      share: 0.7,
      reserve: 4_096,
      margin: 1.2,
      counting: "estimate" as const,
      cache: "none" as const,
      style: "full" as const,
    };
  const window = profile.contextWindow;
  const reserve = Math.min(f.reserve, Math.floor(window / 4));
  return {
    version: CONTEXT_PROFILE_VERSION,
    window,
    workingRange: Math.min(window, overrides.workingRange ?? Math.floor(window * f.share)),
    answerReserve: reserve,
    margin: f.margin,
    counting: f.counting,
    cache: f.cache,
    style: overrides.style ?? (window < 64_000 ? "compact" : f.style),
    ...(overrides.shares && Object.keys(overrides.shares).length > 0
      ? { shares: { ...overrides.shares } }
      : {}),
  };
}

/**
 * The input budget of one call (REQ-CTX-14/AC1): the working range or the input limit, whichever is lower, minus the
 * answer's reserve. Compared with estimates multiplied by the profile's margin.
 *
 * @param context - The model's context profile.
 * @param inputLimit - The most input a call may send (REQ-LLM-12/AC4), when there is one.
 */
export function contextBudget(context: ContextProfile, inputLimit?: number): number {
  return Math.max(
    0,
    Math.min(context.workingRange, inputLimit ?? Number.POSITIVE_INFINITY) - context.answerReserve,
  );
}

/** A system message, plain or with provider options (a cache breakpoint). */
export type RenderedSystem =
  | string
  | {
      readonly role: "system";
      readonly content: string;
      readonly providerOptions: Record<string, Record<string, JSONValue>>;
    };

/**
 * The renderer of a call for its provider (REQ-LLM-15/AC3): with explicit caching (Anthropic) the system message and the
 * first message, the stable prefix, carry the cache breakpoint; providers that cache a stable prefix by themselves or
 * not at all get the messages as they are. Tool results and structured output are the AI SDK's provider adapters'.
 *
 * @param model - The model's context profile and its cache options.
 * @param system - The assembled system message.
 * @param messages - The conversation.
 */
export function renderForProvider<M extends object>(
  model: {
    readonly context: ContextProfile;
    readonly cacheOptions?: Record<string, Record<string, JSONValue>> | undefined;
  },
  system: string,
  messages: readonly M[],
): { readonly system: RenderedSystem; readonly messages: M[] } {
  if (model.context.cache !== "explicit" || !model.cacheOptions) return { system, messages: [...messages] };
  const providerOptions = model.cacheOptions;
  const [first, ...rest] = messages;
  return {
    system: { role: "system", content: system, providerOptions },
    messages: [...(first ? [{ ...first, providerOptions }] : []), ...rest],
  };
}
