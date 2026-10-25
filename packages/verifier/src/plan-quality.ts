import type { Plan, UiScreen } from "@qajitsu/core";
import { selectorKnown, type UiInventory, type UiPlatform } from "./ui-inventory.js";
import { unknownSelectors } from "./ui-snapshot.js";

/** Platforms whose ids a case may name, and how the flag calls that code. */
const CASE_PLATFORMS: Record<string, { readonly platforms: readonly UiPlatform[]; readonly code: string }> = {
  web: { platforms: ["web"], code: "the web pages" },
  mobile: { platforms: ["android", "ios"], code: "the mobile app" },
};

/** Why an expectation of a plan cannot be checked as it is (REQ-PLAN-09). */
export type PlanFlagKind =
  "placeholder" | "schema" | "description-only" | "selector" | "account" | "recorded-text" | "dialog";

/** One expectation a test could not compare with anything meaningful. */
export interface PlanFlag {
  readonly caseId: string;
  readonly stepId: string;
  readonly kind: PlanFlagKind;
  /** The expectation, e.g. `fields.total` or `elements.testid:pay.enabled`. */
  readonly field?: string | undefined;
  readonly value?: unknown;
  readonly reason: string;
}

/** Words that make a lower-case identifier a name standing in for a value (`expected_total`, `reduced_value`). */
const PLACEHOLDER_WORDS = new Set([
  "value",
  "expected",
  "result",
  "original",
  "final",
  "computed",
  "calculated",
  "reduced",
  "intermediate",
  "actual",
  "placeholder",
  "sample",
  "some",
]);

/**
 * Whether a string is a placeholder rather than a value (REQ-PLAN-09/AC1): `<...>`, `{...}`, `${...}`, TBD, TODO,
 * `?`, `...`, N/A, `X,XX`, and identifiers such as `expected_total` or `expectedTotal`. Codes such as
 * `DISCOUNT_NOT_FOUND` and ordinary words are not.
 */
export function isPlaceholder(value: string): boolean {
  const s = value.trim();
  if (s === "") return false;
  if (/^<[^<>]*>$/.test(s) || /^\{\{?[^{}]*\}?\}$/.test(s) || /\$\{[^}]*\}/.test(s)) return true;
  if (/^(tbd|todo|fixme|xxx|n\/a|\?+|\.{3}|…)$/i.test(s)) return true;
  if (/\bX+[.,]X+\b/.test(s)) return true;
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s)) return s.split("_").some((w) => PLACEHOLDER_WORDS.has(w));
  return /^(expected|actual|computed|calculated|original|reduced|final|intermediate|some)[A-Z][A-Za-z0-9]*$/.test(
    s,
  );
}

/** Every string inside a value with its path, e.g. `lines.0.name`. */
function strings(value: unknown, path: string): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}.${String(i)}`));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);

/** Resolves a local `$ref` (`#/components/schemas/Cart`) and merges `allOf`. */
function resolve(doc: Schema, schema: unknown, depth = 0): Schema | undefined {
  if (!isObject(schema) || depth > 20) return undefined;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = doc;
    for (const part of ref.slice(2).split("/")) node = isObject(node) ? node[part] : undefined;
    return resolve(doc, node, depth + 1);
  }
  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    const merged: Schema = { type: "object", properties: {} };
    for (const part of allOf) {
      const r = resolve(doc, part, depth + 1);
      if (r && isObject(r["properties"])) Object.assign(merged["properties"] as Schema, r["properties"]);
    }
    return merged;
  }
  return schema;
}

/** The JSON type of an expected value as OpenAPI names it. */
const jsonType = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? "number" : typeof v;

const typeMatches = (schemaType: unknown, v: unknown): boolean => {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actual = jsonType(v);
  return types.some((t) => t === actual || (t === "integer" && actual === "number" && Number.isInteger(v)));
};

/** The OpenAPI operation of the call a step names (`POST /cart/discount`). */
function operationOf(
  doc: Schema,
  action: string,
): { operation: Schema; verb: string; path: string } | undefined {
  const m = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]*)/i.exec(action) as [string, string, string] | null;
  if (!m) return undefined;
  const [, verb, path] = m;
  const method = verb.toLowerCase();
  const paths = isObject(doc["paths"]) ? doc["paths"] : {};
  const entry = Object.entries(paths).find(([template]) =>
    new RegExp(
      `^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`,
    ).test(path),
  );
  const operation = entry && isObject(entry[1]) ? entry[1][method] : undefined;
  return isObject(operation) ? { operation, verb: verb.toUpperCase(), path } : undefined;
}

/**
 * Whether the documented operation needs a logged-in caller: it answers 401, or it is under `security` (its own, else
 * the document's); `security: []` on an operation opts it out.
 */
function needsLogin(doc: Schema, action: string): string | undefined {
  const op = operationOf(doc, action);
  if (!op) return undefined;
  const responses = isObject(op.operation["responses"]) ? op.operation["responses"] : {};
  const security = "security" in op.operation ? op.operation["security"] : doc["security"];
  const secured = Array.isArray(security) && security.length > 0;
  return "401" in responses || secured ? `${op.verb} ${op.path}` : undefined;
}

/** The response schema of the call a step names (`POST /cart/discount`) for a status. */
function responseSchema(
  doc: Schema,
  action: string,
  status: number | undefined,
): { schema: Schema; where: string } | undefined {
  const op = operationOf(doc, action);
  if (!op) return undefined;
  const { operation, verb, path } = op;
  if (!isObject(operation["responses"])) return undefined;
  const responses = operation["responses"];
  const code = status !== undefined ? String(status) : Object.keys(responses).find((k) => /^2\d\d$/.test(k));
  if (code === undefined) return undefined;
  const response = responses[code];
  const content = isObject(response) && isObject(response["content"]) ? response["content"] : undefined;
  const json = content && isObject(content["application/json"]) ? content["application/json"] : undefined;
  const schema = json ? resolve(doc, json["schema"]) : undefined;
  return schema ? { schema, where: `${verb} ${path} ${code}` } : undefined;
}

/** Checks one expected field against a response schema; returns why it does not fit, if it does not. */
function fieldProblem(doc: Schema, root: Schema, key: string, value: unknown): string | undefined {
  let node: Schema | undefined = root;
  for (const part of key.split(".")) {
    if (!node) return undefined;
    if (/^\d+$/.test(part)) {
      node = resolve(doc, node["items"]);
      continue;
    }
    const props = isObject(node["properties"]) ? node["properties"] : undefined;
    if (!props) return undefined;
    if (!(part in props)) {
      if (node["additionalProperties"] !== undefined && node["additionalProperties"] !== false)
        return undefined;
      return `"${part}" is not a field of the response (fields: ${Object.keys(props).join(", ")})`;
    }
    node = resolve(doc, props[part]);
  }
  if (node?.["type"] === undefined) return undefined;
  return typeMatches(node["type"], value)
    ? undefined
    : `the response field is ${JSON.stringify(node["type"])}, the plan expects ${jsonType(value)} ${JSON.stringify(value)}`;
}

/** Words of a case that tie it to the date or time (offers that end, deadlines, countdowns). */
const TIMELY =
  /\b(date|time|day|hour|minute|deadline|countdown|expir\w*|ends?|ended|until|before|after|christmas|schedul\w*)\b/i;
const timeWords = (c: Plan["cases"][number]): string =>
  [c.title, ...c.steps.flatMap((s) => [s.action, s.expect.description])].join(" ");

/**
 * Expectations of a plan that cannot be checked as they are (REQ-PLAN-09): placeholders instead of values (AC1),
 * fields that do not exist in the OpenAPI response or have another type (AC2), steps with a description only (AC6),
 * and `testid:` selectors that the code under test does not define (AC8). Deterministic; nothing is guessed.
 *
 * @param plan - The plan version.
 * @param options - The OpenAPI document of the application and the element inventory of the code, when known.
 */
export function checkPlanExpectations(
  plan: Plan,
  options: {
    readonly openapi?: unknown;
    readonly inventory?: UiInventory | undefined;
    /** Pages and screens recorded on the environment before planning (REQ-EXEC-22/AC8). */
    readonly snapshot?: readonly UiScreen[] | undefined;
  } = {},
): PlanFlag[] {
  const flags: PlanFlag[] = [];
  const doc = isObject(options.openapi) ? options.openapi : undefined;
  const inventory =
    options.inventory && options.inventory.selectors.length > 0 ? options.inventory : undefined;
  for (const c of plan.cases) {
    // REQ-PLAN-09/AC9: calls that answer 401 without login need a test account (once per case).
    const account = Object.values(c.data).some((v) => typeof v === "string" && /^user:[\w.-]+$/.test(v));
    if (doc && !account && c.type === "api") {
      const step = c.steps.find((s) => s.expect.status !== 401 && needsLogin(doc, s.action) !== undefined);
      if (step)
        flags.push({
          caseId: c.id,
          stepId: step.id,
          kind: "account",
          reason: `${needsLogin(doc, step.action) ?? ""} needs a login (401 without one), but the case names no test account: add one to data, e.g. user: user:standard`,
        });
    }
    for (const s of c.steps) {
      const e = s.expect;
      const flag = (kind: PlanFlagKind, reason: string, field?: string, value?: unknown): void => {
        flags.push({
          caseId: c.id,
          stepId: s.id,
          kind,
          reason,
          ...(field ? { field } : {}),
          ...(value !== undefined ? { value } : {}),
        });
      };
      const checks =
        e.status !== undefined ||
        e.fields !== undefined ||
        e.texts !== undefined ||
        e.elements !== undefined ||
        e.message !== undefined ||
        e.visual !== undefined ||
        e.download !== undefined ||
        e.dialog !== undefined ||
        e.state !== undefined;
      if (s.manual !== true && !checks)
        flag(
          "description-only",
          "the step expects a description only: the test would have nothing to compare",
        );
      // Dogfood pass 2026-10-25: "Confirm the deletion" planned with the dialog's check only, so it was dismissed.
      if (c.type === "web" && e.dialog !== undefined && s.dialog === undefined)
        flag(
          "dialog",
          'the step expects a dialog but does not say how to answer it: add "dialog": {"action": "accept"} or {"action": "dismiss"} to the step (unanswered dialogs are dismissed)',
          "dialog",
        );
      const values = [
        ...Object.entries(e.fields ?? {}).flatMap(([k, v]) => strings(v, `fields.${k}`)),
        ...(e.texts ?? []).map((t, i) => ({ path: `texts.${String(i)}`, text: t })),
        ...Object.entries(e.elements ?? {}).flatMap(([sel, state]) => strings(state, `elements.${sel}`)),
        ...Object.entries(e.message ?? {}).flatMap(([k, v]) => strings(v, `message.${k}`)),
      ];
      for (const v of values)
        if (isPlaceholder(v.text))
          flag("placeholder", "looks like a placeholder, not a value to compare", v.path, v.text);
      for (const [k, v] of Object.entries(e.fields ?? {}))
        if (isObject(v) && Object.keys(v).length === 1 && "value" in v)
          flag(
            "placeholder",
            'the value is wrapped in {"value": ...}; write the value itself',
            `fields.${k}`,
            v,
          );
      if (doc && e.fields) {
        const response = responseSchema(doc, s.action, e.status);
        if (response)
          for (const [k, v] of Object.entries(e.fields)) {
            const problem = fieldProblem(doc, response.schema, k, v);
            if (problem) flag("schema", `${response.where}: ${problem}`, `fields.${k}`, v);
          }
      }
      // In a native app text and value read the same thing: different expectations for both can never pass.
      if (c.type === "mobile")
        for (const [sel, state] of Object.entries(e.elements ?? {}))
          if (state.text !== undefined && state.value !== undefined && state.text !== state.value)
            flag(
              "selector",
              `in a native app text and value of ${sel} are the same visible text: expect text only`,
              `elements.${sel}.value`,
              state.value,
            );
      const target = CASE_PLATFORMS[c.type];
      // REQ-EXEC-22/AC8: with recorded pages of the case's platform, every element must be one of them or in the code.
      const recorded = (options.snapshot ?? []).filter(
        (x) => target?.platforms.includes(x.platform) === true,
      );
      if (recorded.length > 0) {
        // An expected text the recorded page shows differently: a guess, or what the change is about; a person
        // confirms which (dogfood pass 2026-10-25: "Active" planned, "Offer active" shown, a false FAILED).
        for (const [sel, state] of Object.entries(e.elements ?? {})) {
          const id = /^testid:([^\s>]+)$/.exec(sel)?.[1];
          if (id === undefined || state.text === undefined) continue;
          const shown = recorded.flatMap((x) =>
            x.elements.filter((el) => el.testid === id).map((el) => el.text ?? ""),
          );
          const nonEmpty = shown.filter((t) => t !== "");
          if (nonEmpty.length > 0 && !nonEmpty.includes(state.text))
            flag(
              "recorded-text",
              `${sel} shows "${nonEmpty[0] ?? ""}" on the recorded pages, the plan expects "${state.text}": confirm the change or an earlier step makes it so, or use the shown text${c.type === "web" && c.browser?.clock === undefined && TIMELY.test(timeWords(c)) ? '; a text that depends on the date needs "browser": {"clock": "<ISO time>"} on the case' : ""}`,
              `elements.${sel}.text`,
              state.text,
            );
        }
        for (const sel of unknownSelectors(Object.keys(e.elements ?? {}), c.type, {
          screens: recorded,
          inventory: options.inventory,
        }))
          flag(
            "selector",
            // Dogfood pass 2026-10-25: "testid:manifest" planned for the installable app.
            /manifest|service.?worker|installable/i.test(sel)
              ? `${sel} matches no element recorded on the environment's pages; the app manifest and its service worker are checked with "manifest": {"short_name": .., "display": .., "controlled": true}`
              : `${sel} matches no element recorded on the environment's pages`,
            `elements.${sel}`,
          );
        continue;
      }
      // A platform without any id in the code (e.g. its app is not in the repositories) cannot be judged.
      const judged =
        inventory &&
        (target === undefined ||
          inventory.selectors.some((x) => x.platforms.some((p) => target.platforms.includes(p))));
      if (inventory && judged)
        for (const sel of Object.keys(e.elements ?? {})) {
          // An id written as a text (text:cart-count) finds nothing: the element has no such text. On the web the same
          // goes for label:; in a native app label: is the accessibility id and finds it.
          const asId = (c.type === "mobile" ? /^text:([\w.-]+)$/ : /^(?:text|label):([\w.-]+)$/).exec(
            sel,
          )?.[1];
          if (asId !== undefined && selectorKnown(inventory, `testid:${asId}`, target?.platforms))
            flag(
              "selector",
              `${asId} is an element id in the code, not a visible text or label: write testid:${asId}`,
              `elements.${sel}`,
            );
          if (sel.startsWith("testid:") && !selectorKnown(inventory, sel, target?.platforms))
            flag(
              "selector",
              `${sel} is not defined in the code ${target ? `of ${target.code}` : "under test"}`,
              `elements.${sel}`,
            );
        }
    }
  }
  return flags;
}

/** The schema of one expected field (`total`, `lines.0.total`), when the response schema describes it. */
function fieldNode(doc: Schema, root: Schema, key: string): Schema | undefined {
  let node: Schema | undefined = root;
  for (const part of key.split(".")) {
    if (!node) return undefined;
    if (/^\d+$/.test(part)) {
      node = resolve(doc, node["items"]);
      continue;
    }
    const props: unknown = node["properties"];
    if (!isObject(props) || !(part in props)) return undefined;
    node = resolve(doc, props[part]);
  }
  return node;
}

/** An exact decimal number as JSON writes it: no sign but minus, no leading zeros, no exponent, no spaces or units. */
const EXACT_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** One expected value code turned from text into a number (REQ-PLAN-12/AC1). */
export interface NumericConversion {
  readonly caseId: string;
  readonly stepId: string;
  /** `fields.total` */
  readonly field: string;
  readonly from: string;
  readonly to: number;
  /** The documented response it was checked against, e.g. `GET /cart 200`. */
  readonly where: string;
}

/**
 * Turns expected values written as text into numbers where the OpenAPI response schema leaves no doubt
 * (REQ-PLAN-12): the field is `number` or `integer` and the text is exactly a decimal number (`"1.01"`, `"-3"`; a
 * whole number for `integer`). Anything else stays as written for the type check to flag (REQ-PLAN-09/AC2). Only the
 * type changes, never the value; the input is not modified.
 *
 * @param plan - A plan or a draft.
 * @param openapi - The application's OpenAPI document; without one nothing is converted.
 * @returns The plan with converted values, and every conversion.
 */
export function convertNumericStrings<T extends { readonly cases: Plan["cases"] }>(
  plan: T,
  openapi: unknown,
): { plan: T; conversions: NumericConversion[] } {
  const conversions: NumericConversion[] = [];
  if (!isObject(openapi)) return { plan, conversions };
  const doc = openapi;
  const cases = plan.cases.map((c) => ({
    ...c,
    steps: c.steps.map((s) => {
      const fields = s.expect.fields;
      const response = fields ? responseSchema(doc, s.action, s.expect.status) : undefined;
      if (!fields || !response) return s;
      const next = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => {
          if (typeof value !== "string" || !EXACT_DECIMAL.test(value)) return [key, value];
          const types: unknown[] = [fieldNode(doc, response.schema, key)?.["type"]].flat();
          const to = Number(value);
          const fits = types.includes("number") || (types.includes("integer") && Number.isInteger(to));
          if (!fits || !Number.isFinite(to)) return [key, value];
          conversions.push({
            caseId: c.id,
            stepId: s.id,
            field: `fields.${key}`,
            from: value,
            to,
            where: response.where,
          });
          return [key, to];
        }),
      );
      return { ...s, expect: { ...s.expect, fields: next } };
    }),
  }));
  return { plan: conversions.length === 0 ? plan : { ...plan, cases }, conversions };
}

/** The conversions as lines next to the plan (REQ-PLAN-12/AC1). */
export function formatNumericConversions(conversions: readonly NumericConversion[]): string {
  return conversions
    .map(
      (v) =>
        `  ~ ${v.caseId} ${v.stepId} ${v.field}: ${JSON.stringify(v.from)} → ${String(v.to)} (${v.where}: number)`,
    )
    .join("\n");
}

/** The flags as lines for the review (REQ-PLAN-09/AC3). */
export function formatPlanFlags(flags: readonly PlanFlag[]): string {
  return flags
    .map(
      (f) =>
        `  ! ${f.caseId} ${f.stepId}${f.field ? ` ${f.field}` : ""}${f.value !== undefined ? ` = ${JSON.stringify(f.value)}` : ""}: ${f.reason}`,
    )
    .join("\n");
}
