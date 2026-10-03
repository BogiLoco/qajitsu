import type { ApiTransport } from "@qajitsu/steps";
import { request as playwrightRequest, type APIRequestContext } from "playwright-core";

/**
 * API transport on Playwright `APIRequestContext` (REQ-EXEC-04/AC1). Redirects are not followed, so a
 * response cannot send credentials to another origin; specs see the 3xx and assert on it.
 *
 * @returns The transport and a `dispose` that closes the request context.
 */
export async function createPlaywrightTransport(options: {
  readonly timeoutMs: number;
}): Promise<{ transport: ApiTransport; dispose: () => Promise<void> }> {
  const context: APIRequestContext = await playwrightRequest.newContext({ timeout: options.timeoutMs });
  return {
    transport: async (req) => {
      const response = await context.fetch(req.url, {
        method: req.method,
        headers: { ...req.headers },
        ...(req.body === undefined
          ? {}
          : { data: typeof req.body === "string" ? req.body : JSON.stringify(req.body) }),
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      return { status: response.status(), headers: response.headers(), text: await response.text() };
    },
    dispose: () => context.dispose(),
  };
}
