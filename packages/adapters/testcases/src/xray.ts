import {
  AdapterError,
  createHttpClient,
  type AdapterDeps,
  type ImportedCase,
  type TestCaseSource,
  type TicketKey,
} from "@qajitsu/core";
import { z } from "zod";
import { MAX_CASES, toCase } from "./common.js";

/** Xray Cloud API access (REQ-CTX-08/AC1). */
export interface XrayConfig {
  /** `https://xray.cloud.getxray.app` (or the regional endpoint). */
  readonly baseUrl: string;
  /** `secret://` references of the API key pair. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** JQL selecting the tests of a ticket; `{ticket}` is replaced by the key. */
  readonly jql?: string | undefined;
}

/** Default JQL: Test issues linked to the ticket. */
export const XRAY_DEFAULT_JQL = 'issue in linkedIssues("{ticket}") AND issuetype = Test';

const QUERY = `query($jql: String!, $limit: Int!, $start: Int!) {
  getTests(jql: $jql, limit: $limit, start: $start) {
    total
    results {
      jira(fields: ["key", "summary"])
      steps { action data result }
      gherkin
      unstructured
      preconditions(limit: 10) { results { definition } }
    }
  }
}`;

const TestSchema = z
  .object({
    jira: z.object({ key: z.string(), summary: z.string().nullish() }).loose(),
    steps: z
      .array(
        z.object({ action: z.string().nullish(), data: z.string().nullish(), result: z.string().nullish() }),
      )
      .nullish(),
    gherkin: z.string().nullish(),
    unstructured: z.string().nullish(),
    preconditions: z
      .object({ results: z.array(z.object({ definition: z.string().nullish() })).nullish() })
      .nullish(),
  })
  .loose();

const ResponseSchema = z.object({
  data: z
    .object({ getTests: z.object({ total: z.number(), results: z.array(TestSchema) }).nullish() })
    .nullish(),
  errors: z.array(z.object({ message: z.string() }).loose()).nullish(),
});

/**
 * Manual test cases from Xray Cloud through its GraphQL API: the tests the JQL finds for the ticket, with their
 * steps (action, data, expected result), Gherkin or generic definition and preconditions.
 *
 * @example
 * const xray = createXrayCaseSource({ baseUrl: "https://xray.cloud.getxray.app", clientId, clientSecret }, deps);
 * const cases = await xray.findCases(ticket);
 */
export function createXrayCaseSource(config: XrayConfig, deps: AdapterDeps): TestCaseSource {
  let token: string | undefined;
  const anonymous = createHttpClient({
    service: "XRAY",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: () => Promise.resolve({}),
  });
  const http = createHttpClient({
    service: "XRAY",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: () => Promise.resolve(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  });
  const authenticate = async (signal?: AbortSignal): Promise<void> => {
    if (token !== undefined) return;
    const body = JSON.stringify({
      client_id: await deps.resolveSecret(config.clientId),
      client_secret: await deps.resolveSecret(config.clientSecret),
    });
    const value = await anonymous.json("api/v2/authenticate", z.string().min(1), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    });
    deps.registerSecret(value);
    token = value;
  };
  return {
    system: "xray",
    async findCases(ticket: TicketKey, signal?: AbortSignal): Promise<readonly ImportedCase[]> {
      await authenticate(signal);
      const jql = (config.jql ?? XRAY_DEFAULT_JQL).replaceAll("{ticket}", ticket);
      const out: ImportedCase[] = [];
      for (let start = 0; out.length < MAX_CASES; start += 100) {
        const response = await http.json("api/v2/graphql", ResponseSchema, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { jql, limit: 100, start } }),
          signal,
        });
        if (response.errors && response.errors.length > 0)
          throw new AdapterError(
            "XRAY_GRAPHQL",
            `Xray rejected the query: ${response.errors[0]?.message ?? ""}`,
            {},
          );
        const page = response.data?.getTests;
        if (!page) throw new AdapterError("XRAY_MALFORMED", "Xray answered without getTests.", {});
        for (const t of page.results) {
          const steps =
            t.steps && t.steps.length > 0
              ? t.steps.map((s) => ({ action: s.action, data: s.data, expected: s.result }))
              : t.gherkin
                ? [{ action: t.gherkin }]
                : t.unstructured
                  ? [{ action: t.unstructured }]
                  : [];
          const c = toCase({
            system: "xray",
            id: t.jira.key,
            title: t.jira.summary,
            preconditions: (t.preconditions?.results ?? [])
              .map((p) => p.definition ?? "")
              .filter(Boolean)
              .join("\n"),
            steps,
          });
          if (c) out.push(c);
        }
        if (page.results.length < 100 || start + 100 >= page.total) break;
      }
      return out.slice(0, MAX_CASES);
    },
  };
}
