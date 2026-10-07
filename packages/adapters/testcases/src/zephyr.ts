import {
  createHttpClient,
  htmlToText,
  type AdapterDeps,
  type ImportedCase,
  type TestCaseSource,
  type TicketKey,
} from "@qajitsu/core";
import { z } from "zod";
import { MAX_CASES, toCase } from "./common.js";

/** Zephyr Scale Cloud API access (REQ-CTX-08/AC1). */
export interface ZephyrConfig {
  /** `https://api.zephyrscale.smartbear.com/v2` (or the EU endpoint). */
  readonly baseUrl: string;
  /** `secret://` reference of the API access token. */
  readonly token: string;
}

const text = (html: string | null | undefined): string | undefined =>
  html === null || html === undefined || html.trim() === "" ? undefined : htmlToText(html);

const KEY = /^[A-Z][A-Z0-9_]+-T\d+$/;

/**
 * Manual test cases from Zephyr Scale Cloud: the test cases linked to the ticket, with objective, precondition and
 * inline steps (description, test data, expected result); HTML is converted to text.
 *
 * @example
 * const zephyr = createZephyrCaseSource({ baseUrl: "https://api.zephyrscale.smartbear.com/v2", token }, deps);
 */
export function createZephyrCaseSource(config: ZephyrConfig, deps: AdapterDeps): TestCaseSource {
  const http = createHttpClient({
    service: "ZEPHYR",
    baseUrl: config.baseUrl,
    fetch: deps.fetch,
    headers: async () => ({ authorization: `Bearer ${await deps.resolveSecret(config.token)}` }),
  });
  return {
    system: "zephyr",
    async findCases(ticket: TicketKey, signal?: AbortSignal): Promise<readonly ImportedCase[]> {
      const links = await http.json(
        `issuelinks/${ticket}/testcases`,
        z.array(z.object({ key: z.string() }).loose()),
        {
          signal,
        },
      );
      const out: ImportedCase[] = [];
      for (const { key } of links.filter((l) => KEY.test(l.key)).slice(0, MAX_CASES)) {
        const tc = await http.json(
          `testcases/${key}`,
          z
            .object({
              key: z.string(),
              name: z.string(),
              objective: z.string().nullish(),
              precondition: z.string().nullish(),
            })
            .loose(),
          { signal },
        );
        const steps = await http.json(
          `testcases/${key}/teststeps?maxResults=100`,
          z.object({
            values: z.array(
              z
                .object({
                  inline: z
                    .object({
                      description: z.string().nullish(),
                      testData: z.string().nullish(),
                      expectedResult: z.string().nullish(),
                    })
                    .nullish(),
                })
                .loose(),
            ),
          }),
          { signal },
        );
        const c = toCase({
          system: "zephyr",
          id: tc.key,
          title: tc.name,
          preconditions: [text(tc.objective), text(tc.precondition)].filter(Boolean).join("\n"),
          steps: steps.values.flatMap((s) =>
            s.inline
              ? [
                  {
                    action: text(s.inline.description),
                    data: text(s.inline.testData),
                    expected: text(s.inline.expectedResult),
                  },
                ]
              : [],
          ),
        });
        if (c) out.push(c);
      }
      return out;
    },
  };
}
