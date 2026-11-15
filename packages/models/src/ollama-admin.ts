import { AdapterError } from "@qajitsu/core";
import { z } from "zod";

/** A model present in an Ollama server, with the digest of its manifest. */
export interface OllamaModel {
  /** `name:tag`, e.g. `qwen3:4b`. */
  readonly name: string;
  /** `sha256:<hex>`. */
  readonly digest: string;
}

const HEX = /^(?:sha256:)?([0-9a-f]{64})$/;

/** `GET /api/tags`: Ollama lists digests as bare hex; both forms are accepted. */
export const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1), digest: z.string().regex(HEX) })),
});

/** `http://host:11434`, `http://host:11434/` and `http://host:11434/api` all name the same server. */
const apiUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/${path}`;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Pulls a model into an Ollama server (REQ-GEN-10/AC3): the stack's one-shot step runs this for every role model.
 * Resolves only when the stream reports `success`; an error line, an HTTP error, a broken connection or a stream that
 * ends early fails with the model's name.
 *
 * @param baseUrl - The server, e.g. `http://ollama:11434`.
 * @param name - `name:tag`.
 * @param fetch - Injected fetch (tests, proxies).
 * @throws {AdapterError} `OLLAMA_PULL_FAILED` with `{ model }`.
 * @example
 * await ollamaPull("http://ollama:11434", "qwen3:4b", fetch);
 */
export async function ollamaPull(
  baseUrl: string,
  name: string,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const failed = (why: string) =>
    new AdapterError("OLLAMA_PULL_FAILED", `Pulling ${name} into Ollama failed: ${why}`, { model: name });
  let response: Response;
  try {
    response = await fetch(apiUrl(baseUrl, "pull"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, stream: true }),
    });
  } catch (error) {
    throw failed(describeError(error));
  }
  if (!response.ok) throw failed(`HTTP ${String(response.status)}`);
  let success = false;
  for (const line of (await response.text()).split("\n")) {
    if (line.trim() === "") continue;
    let event: { status?: unknown; error?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      throw failed(`unreadable answer ${line.slice(0, 80)}`);
    }
    if (typeof event.error === "string") throw failed(event.error);
    if (event.status === "success") success = true;
  }
  if (!success) throw failed("the stream ended before success");
}

/**
 * The models an Ollama server holds, with their digests (REQ-GEN-10/AC4): the stack checks them against the pinned
 * digests, and a run records them (REQ-OBS-10).
 *
 * @param baseUrl - The server, e.g. `http://ollama:11434`.
 * @param fetch - Injected fetch.
 * @throws {AdapterError} `OLLAMA_UNAVAILABLE` when the server does not answer with a list of models and digests.
 */
export async function ollamaTags(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
): Promise<readonly OllamaModel[]> {
  const unavailable = (why: string) =>
    new AdapterError("OLLAMA_UNAVAILABLE", `Ollama at ${baseUrl} did not list its models: ${why}`, {
      baseUrl,
    });
  let response: Response;
  try {
    response = await fetch(apiUrl(baseUrl, "tags"));
  } catch (error) {
    throw unavailable(describeError(error));
  }
  if (!response.ok) throw unavailable(`HTTP ${String(response.status)}`);
  const parsed = OllamaTagsSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw unavailable("the answer is not a list of models with sha256 digests");
  return parsed.data.models.map((m) => ({ name: m.name, digest: `sha256:${HEX.exec(m.digest)?.[1] ?? ""}` }));
}
