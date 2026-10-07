import {
  createHttpClient,
  type AdapterDeps,
  type ImportedCase,
  type TestCaseSource,
  type TicketKey,
} from "@qajitsu/core";
import { z } from "zod";
import { MAX_CASES, toCase } from "./common.js";

/** TestRail API access (REQ-CTX-08/AC1). */
export interface TestRailConfig {
  /** e.g. `https://example.testrail.io`. */
  readonly baseUrl: string;
  /** `secret://` reference (or plain value) of the user e-mail. */
  readonly user: string;
  /** `secret://` reference of the API key. */
  readonly token: string;
  readonly projectId: number;
  /** Needed for projects with several suites. */
  readonly suiteId?: number | undefined;
}

const CaseSchema = z
  .object({
    id: z.number().int(),
    title: z.string(),
    refs: z.string().nullish(),
    custom_preconds: z.string().nullish(),
    custom_steps_separated: z
      .array(
        z.object({
          content: z.string().nullish(),
          expected: z.string().nullish(),
          additional_info: z.string().nullish(),
        }),
      )
      .nullish(),
    custom_steps: z.string().nullish(),
    custom_expected: z.string().nullish(),
  })
  .loose();

const PageSchema = z.union([
  z.array(CaseSchema),
  z.object({
    cases: z.array(CaseSchema),
    _links: z.object({ next: z.string().nullish() }).loose().nullish(),
  }),
]);

/**
 * Manual test cases from TestRail: the cases of the project (and suite) whose References contain the ticket key,
 * with preconditions and separated steps (or the text steps template).
 *
 * @example
 * const testrail = createTestRailCaseSource({ baseUrl, user, token, projectId: 3 }, deps);
 */
export function createTestRailCaseSource(config: TestRailConfig, deps: AdapterDeps): TestCaseSource {
  const resolve = (v: string): Promise<string> =>
    v.startsWith("secret://") ? deps.resolveSecret(v) : Promise.resolve(v);
  const http = createHttpClient({
    service: "TESTRAIL",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: async () => ({
      authorization: `Basic ${Buffer.from(`${await resolve(config.user)}:${await resolve(config.token)}`).toString("base64")}`,
      "content-type": "application/json",
    }),
  });
  return {
    system: "testrail",
    async findCases(ticket: TicketKey, signal?: AbortSignal): Promise<readonly ImportedCase[]> {
      const suite = config.suiteId === undefined ? "" : `&suite_id=${String(config.suiteId)}`;
      let path: string | undefined =
        `index.php?/api/v2/get_cases/${String(config.projectId)}${suite}&refs=${encodeURIComponent(ticket)}`;
      const out: ImportedCase[] = [];
      while (path !== undefined && out.length < MAX_CASES) {
        const page: z.infer<typeof PageSchema> = await http.json(path, PageSchema, { signal });
        const cases = Array.isArray(page) ? page : page.cases;
        for (const c of cases) {
          // The refs filter matches substrings; keep only cases that name exactly this ticket.
          if (!(c.refs ?? "").split(/[,\s]+/).includes(ticket)) continue;
          const steps =
            c.custom_steps_separated && c.custom_steps_separated.length > 0
              ? c.custom_steps_separated.map((s) => ({
                  action: s.content,
                  data: s.additional_info,
                  expected: s.expected,
                }))
              : c.custom_steps || c.custom_expected
                ? [{ action: c.custom_steps, expected: c.custom_expected }]
                : [];
          const imported = toCase({
            system: "testrail",
            id: `C${String(c.id)}`,
            title: c.title,
            preconditions: c.custom_preconds,
            steps,
            url: `${config.baseUrl.replace(/\/$/, "")}/index.php?/cases/view/${String(c.id)}`,
          });
          if (imported) out.push(imported);
        }
        const next: string | null | undefined = Array.isArray(page) ? undefined : page._links?.next;
        path = next ? `index.php?${next.replace(/^\/?(index\.php\?)?/, "")}` : undefined;
      }
      return out.slice(0, MAX_CASES);
    },
  };
}
