import type { ApiRequest, ApiTransport } from "@qajitsu/steps";
import { request as playwrightRequest, type APIRequestContext } from "playwright-core";

/** The body options of Playwright's `fetch` for a request: JSON, multipart, form or raw bytes (REQ-EXEC-45/AC1). */
function bodyOf(req: ApiRequest): {
  data?: string | Buffer;
  form?: Record<string, string>;
  multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>;
} {
  const p = req.payload;
  if (p?.kind === "multipart")
    return {
      multipart: {
        ...p.fields,
        ...Object.fromEntries(
          Object.entries(p.files).map(([field, f]) => [
            field,
            { name: f.name, mimeType: f.type, buffer: Buffer.from(f.data) },
          ]),
        ),
      },
    };
  if (p?.kind === "form") return { form: { ...p.fields } };
  if (p?.kind === "bytes") return { data: Buffer.from(p.data) };
  if (req.body === undefined) return {};
  return { data: typeof req.body === "string" ? req.body : JSON.stringify(req.body) };
}

/**
 * API transport on Playwright `APIRequestContext` (REQ-EXEC-04/AC1). Redirects are not followed, so a
 * response cannot send credentials to another origin; specs see the 3xx and assert on it.
 *
 * @returns The transport and a `dispose` that closes the request context.
 */
export async function createPlaywrightTransport(options: {
  readonly timeoutMs: number;
  /** HTTP authentication of the environment (REQ-EXEC-61/AC5), sent when the server asks for it. */
  readonly httpCredentials?: { readonly username: string; readonly password: string } | undefined;
  /** Headers the application offers for tests (REQ-EXEC-55/AC4), sent to its origin only. */
  readonly testHeaders?:
    { readonly origin: string; readonly headers: Readonly<Record<string, string>> } | undefined;
}): Promise<{ transport: ApiTransport; dispose: () => Promise<void> }> {
  const context: APIRequestContext = await playwrightRequest.newContext({
    timeout: options.timeoutMs,
    ...(options.httpCredentials
      ? { httpCredentials: { ...options.httpCredentials, send: "unauthorized" as const } }
      : {}),
  });
  return {
    transport: async (req) => {
      const response = await context.fetch(req.url, {
        method: req.method,
        headers: {
          ...req.headers,
          ...(new URL(req.url).origin === options.testHeaders?.origin ? options.testHeaders.headers : {}),
        },
        ...bodyOf(req),
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      // The bytes as they came, so a file response is kept exactly (REQ-EXEC-45/AC2).
      const bytes = await response.body();
      return {
        status: response.status(),
        headers: response.headers(),
        text: bytes.toString("utf8"),
        bytes: new Uint8Array(bytes),
      };
    },
    dispose: () => context.dispose(),
  };
}
