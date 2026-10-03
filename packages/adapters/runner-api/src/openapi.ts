import { readFile } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import { parse } from "yaml";

/** Validates recorded API responses against an OpenAPI 3 document (REQ-EXEC-04/AC2). */
export interface ContractValidator {
  /**
   * @returns Problems for this response; empty when it matches, `undefined` when the document has no
   *   operation for the method, path and status (not checked).
   */
  check(method: string, url: string, status: number, body: unknown): string[] | undefined;
}

const escapePointer = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** Turns `/cart/{id}` into a matcher for concrete paths. */
const templateMatcher = (template: string): RegExp =>
  new RegExp(
    `^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}|\{[^}]+\}/g, "[^/]+")}$`,
  );

/**
 * Builds a validator from an OpenAPI 3.x document (JSON or YAML). `$ref`s into the document resolve;
 * OpenAPI keywords Ajv does not know (`nullable`, `example`, ...) are ignored rather than rejected.
 *
 * @param document - Parsed OpenAPI document.
 */
export function createContractValidator(document: Record<string, unknown>): ContractValidator {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ ...document, $id: "openapi" });
  const paths = (document["paths"] ?? {}) as Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>
  >;
  const templates = Object.keys(paths).map((t) => ({ template: t, match: templateMatcher(t) }));
  const cache = new Map<string, ValidateFunction | null>();
  return {
    check(method, url, status, body) {
      const pathname = new URL(url).pathname;
      const hit = templates.find((t) => t.match.test(pathname));
      if (!hit) return undefined;
      const operation = paths[hit.template]?.[method.toLowerCase()];
      const responses = operation?.responses;
      if (!responses) return undefined;
      const code =
        String(status) in responses
          ? String(status)
          : `${String(status).charAt(0)}XX` in responses
            ? `${String(status).charAt(0)}XX`
            : "default" in responses
              ? "default"
              : undefined;
      if (code === undefined)
        return [
          `${method} ${hit.template} returned ${String(status)}, which the OpenAPI document does not declare`,
        ];
      const json = responses[code]?.content?.["application/json"];
      if (!json?.schema) return [];
      const key = `${hit.template} ${method} ${code}`;
      let validate = cache.get(key);
      if (validate === undefined) {
        validate = ajv.compile({
          $ref: `openapi#/paths/${escapePointer(hit.template)}/${method.toLowerCase()}/responses/${code}/content/application~1json/schema`,
        });
        cache.set(key, validate);
      }
      if (validate === null) return [];
      return validate(body)
        ? []
        : (validate.errors ?? []).map(
            (e) =>
              `${method} ${hit.template} ${String(status)}: body${e.instancePath} ${e.message ?? "is invalid"}`,
          );
    },
  };
}

/**
 * Loads an OpenAPI document from a file (`.json`, `.yaml`, `.yml`).
 *
 * @param file - Path, normally inside a repository worktree of the run (the analysed version).
 */
export async function loadContractValidator(file: string): Promise<ContractValidator> {
  const text = await readFile(file, "utf8");
  const doc = (file.endsWith(".json") ? JSON.parse(text) : parse(text)) as Record<string, unknown>;
  return createContractValidator(doc);
}
