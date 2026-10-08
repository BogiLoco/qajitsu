// A stand-in for the Claude Messages API that follows its public documentation
// (https://platform.claude.com/docs/en/api/messages, .../api/errors, retrieved 2026-10-08):
// POST /v1/messages with `x-api-key` and `anthropic-version: 2023-06-01`; `model`, `max_tokens` and `messages`
// required; answers `type: "message"` with `text` or `tool_use` content blocks, `stop_reason` and `usage`;
// tool results come back as `tool_result` blocks naming the `tool_use` id; errors are
// `{ type: "error", error: { type, message }, request_id }` with the documented status codes. It also enforces the
// documented limits of current models: no assistant prefill (the last message is the user's) and no forced tool use
// (`tool_choice` `any` or `tool`). A request that breaks the documentation gets the documented 400 and is recorded.

/** One scripted answer of the model. */
export type AnthropicTurn =
  | { readonly text: string; readonly usage?: { readonly input: number; readonly output: number } }
  | { readonly tool: { readonly name: string; readonly input: Record<string, unknown> } }
  | { readonly error: 401 | 429 | 500 | 529; readonly retryAfter?: number };

interface ContentBlock {
  readonly type: string;
  readonly id?: string;
  readonly tool_use_id?: string;
}
interface RequestBody {
  readonly model?: unknown;
  readonly max_tokens?: unknown;
  readonly messages?: readonly {
    readonly role: string;
    readonly content: string | readonly ContentBlock[];
  }[];
  readonly tool_choice?: { readonly type: string };
  readonly thinking?: { readonly type: string };
  readonly output_config?: { readonly format?: { readonly type: string } };
  readonly tools?: readonly { readonly name: string }[];
}

const ERRORS: Readonly<Record<number, readonly [string, string]>> = {
  400: ["invalid_request_error", "There was an issue with the format or content of your request."],
  401: ["authentication_error", "invalid x-api-key"],
  429: ["rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit."],
  500: ["api_error", "An unexpected error has occurred internal to Anthropic's systems."],
  529: ["overloaded_error", "Overloaded"],
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_011CSHoEeqs5C35K2UUqR7Fy", ...headers },
  });

const error = (status: number, message?: string, headers: Record<string, string> = {}): Response =>
  json(
    status,
    {
      type: "error",
      error: { type: ERRORS[status]?.[0] ?? "api_error", message: message ?? ERRORS[status]?.[1] ?? "error" },
      request_id: "req_011CSHoEeqs5C35K2UUqR7Fy",
    },
    headers,
  );

/** Why a request breaks the documented API, or undefined when it conforms. */
function violation(
  url: URL,
  method: string,
  headers: Headers,
  body: RequestBody,
  key: string,
): string | undefined {
  if (method !== "POST" || url.pathname !== "/v1/messages")
    return `${method} ${url.pathname} is not POST /v1/messages`;
  if (headers.get("anthropic-version") !== "2023-06-01") return "anthropic-version header must be 2023-06-01";
  if (headers.get("x-api-key") !== key) return "x-api-key header missing or wrong";
  if (typeof body.model !== "string" || body.model === "") return "model is required";
  if (typeof body.max_tokens !== "number" || body.max_tokens < 1) return "max_tokens is required";
  const messages = body.messages ?? [];
  if (messages.length === 0) return "messages is required";
  if (messages[0]?.role !== "user") return "the first message must be the user's";
  for (let i = 1; i < messages.length; i += 1)
    if (messages[i]?.role === messages[i - 1]?.role) return `messages.${String(i)}: roles must alternate`;
  if (messages.at(-1)?.role !== "user")
    return "This model does not support assistant message prefill. The conversation must end with a user message.";
  if (body.tool_choice && body.tool_choice.type !== "auto" && body.tool_choice.type !== "none")
    return 'tool_choice: type "tool" and "any" are not supported for this model.';
  if (body.thinking?.type === "disabled") return '"thinking.type.disabled" is not supported for this model.';
  // Every tool_result must answer a tool_use of the assistant message right before it.
  for (let i = 0; i < messages.length; i += 1) {
    const content = messages[i]?.content;
    if (typeof content === "string") continue;
    for (const block of content ?? []) {
      if (block.type !== "tool_result") continue;
      const before = messages[i - 1]?.content;
      const ids =
        typeof before === "string"
          ? []
          : (before ?? []).filter((b) => b.type === "tool_use").map((b) => b.id);
      if (!ids.includes(block.tool_use_id))
        return `messages.${String(i)}: tool_result for an unknown tool_use_id`;
    }
  }
  return undefined;
}

/**
 * A `fetch` that answers like the Claude Messages API with the scripted turns, in order.
 *
 * @param script - The model's answers.
 * @param options - The API key the requests must carry.
 * @returns The fetch, every request body it received and every documented rule a request broke.
 */
export function createAnthropicApi(
  script: readonly AnthropicTurn[],
  options: { readonly apiKey: string; readonly model?: string },
): { fetch: typeof globalThis.fetch; requests: RequestBody[]; violations: string[] } {
  const requests: RequestBody[] = [];
  const violations: string[] = [];
  let next = 0;
  let toolIds = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = (await request.json().catch(() => ({}))) as RequestBody;
    requests.push(body);
    const broken = violation(new URL(request.url), request.method, request.headers, body, options.apiKey);
    if (broken !== undefined) {
      violations.push(broken);
      return error(broken.includes("x-api-key") ? 401 : 400, broken);
    }
    const turn = script[next];
    next += 1;
    if (turn === undefined) return error(500, "the test script has no more answers");
    if ("error" in turn)
      return error(
        turn.error,
        undefined,
        turn.retryAfter === undefined ? {} : { "retry-after": String(turn.retryAfter) },
      );
    const model = options.model ?? (typeof body.model === "string" ? body.model : "claude");
    if ("tool" in turn) {
      toolIds += 1;
      return json(200, {
        id: `msg_${String(next)}`,
        type: "message",
        role: "assistant",
        model,
        content: [
          {
            type: "tool_use",
            id: `toolu_${String(toolIds).padStart(24, "0")}`,
            name: turn.tool.name,
            input: turn.tool.input,
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 25 },
      });
    }
    return json(200, {
      id: `msg_${String(next)}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: turn.text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: turn.usage?.input ?? 10, output_tokens: turn.usage?.output ?? 15 },
    });
  };
  return { fetch: fetch, requests, violations };
}
