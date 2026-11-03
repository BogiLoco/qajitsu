import { readFile } from "node:fs/promises";
import type { ResolvedEnvironment } from "@qajitsu/core";
import { buildGraphqlSchema, getIntrospectionQuery } from "@qajitsu/verifier";
import type { RunSession } from "./session.js";

/** The schema type of `@qajitsu/verifier`'s GraphQL checks. */
export type GraphqlSchema = ReturnType<typeof buildGraphqlSchema>;

/**
 * The GraphQL schema of the analysed commit (REQ-EXEC-48/AC1): the SDL file a repository names under `graphql`, read
 * from the run's worktree, or, for an endpoint path such as `/graphql`, the answer of an introspection query to the
 * test environment (its own origin only, invariant 10). Undefined when no repository names one, or when an endpoint
 * is named but no environment is given.
 *
 * @param session - The run.
 * @param options - The environment to introspect, and the fetch.
 * @throws {ConfigError} `GRAPHQL_SCHEMA_INVALID` when the file or the answer is not a schema.
 */
export async function graphqlSchemaOf(
  session: Pick<RunSession, "project" | "ws">,
  options: { readonly env?: ResolvedEnvironment | undefined; readonly fetch: typeof globalThis.fetch },
): Promise<{ readonly schema: GraphqlSchema; readonly source: string } | undefined> {
  for (const [alias, repo] of Object.entries(session.project.config.repos)) {
    const where = repo.graphql;
    if (where === undefined || session.ws.record.repos[alias] === undefined) continue;
    if (!where.startsWith("/"))
      return {
        schema: buildGraphqlSchema(await readFile(session.ws.path("repos", alias, where), "utf8")),
        source: `${alias}/${where}`,
      };
    if (options.env === undefined) return undefined;
    const url = new URL(where, options.env.baseUrl);
    const res = await options.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    return { schema: buildGraphqlSchema(await res.text()), source: `introspection of ${url.toString()}` };
  }
  return undefined;
}
