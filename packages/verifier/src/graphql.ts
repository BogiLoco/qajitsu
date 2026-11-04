import { ConfigError, type AssertionRecord, type AttemptRecord, type Plan } from "@qajitsu/core";
import {
  buildClientSchema,
  buildSchema,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  OperationTypeNode,
  parse,
  validate,
  type DocumentNode,
  type GraphQLError,
  type FragmentDefinitionNode,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery,
  type SelectionSetNode,
} from "graphql";

export { getIntrospectionQuery } from "graphql";

/**
 * The GraphQL schema of the analysed commit (REQ-EXEC-48/AC1): SDL from the repository, or the answer of an
 * introspection query to the allowlisted test environment (with or without its `data` envelope).
 *
 * @param text - SDL, or introspection JSON.
 * @throws {ConfigError} `GRAPHQL_SCHEMA_INVALID` when it is neither.
 */
export function buildGraphqlSchema(text: string): GraphQLSchema {
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as { data?: IntrospectionQuery } & Partial<IntrospectionQuery>;
      const introspection = parsed.data ?? parsed;
      if (introspection.__schema === undefined) throw new Error("no __schema in the introspection answer");
      return buildClientSchema(introspection as IntrospectionQuery);
    }
    return buildSchema(trimmed);
  } catch (error) {
    throw new ConfigError(
      "GRAPHQL_SCHEMA_INVALID",
      `The GraphQL schema cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      {},
    );
  }
}

const ROOTS = ["Query", "Mutation", "Subscription"] as const;

/** The root operations of a schema with their arguments and types, for the planner (REQ-EXEC-48/AC1). */
export function graphqlOperations(schema: GraphQLSchema): string[] {
  const out: string[] = [];
  const roots = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()];
  roots.forEach((type, i) => {
    if (!type) return;
    for (const field of Object.values(type.getFields())) {
      const args = field.args.map((a) => `${a.name}: ${String(a.type)}`).join(", ");
      out.push(`${ROOTS[i] ?? "Query"}.${field.name}${args ? `(${args})` : ""}: ${String(field.type)}`);
    }
  });
  return out;
}

/** One GraphQL exchange of an attempt, read from its call record. */
interface Exchange {
  readonly stepId: string;
  readonly query: string;
  readonly response: { readonly data?: unknown; readonly errors?: unknown };
}

function exchanges(record: AttemptRecord): Exchange[] {
  return record.evidence.flatMap((item) => {
    if (typeof item.content !== "string") return [];
    try {
      const call = JSON.parse(item.content) as {
        graphql?: unknown;
        request?: { body?: { query?: unknown } };
        response?: { body?: unknown };
        frames?: unknown;
      };
      const query = call.request?.body?.query;
      const body = call.response?.body;
      // Only calls made with api.graphql() or api.subscribe() are GraphQL; a REST body with a `query` field is not.
      if (call.graphql !== true || typeof query !== "string") return [];
      // REQ-EXEC-48/AC2: a subscription is checked payload by payload; without one its query is still checked.
      if (Array.isArray(call.frames)) {
        const payloads = (call.frames as { dir?: unknown; data?: unknown }[]).flatMap((f) => {
          if (f.dir !== "received" || typeof f.data !== "string") return [];
          try {
            const frame = JSON.parse(f.data) as { type?: unknown; payload?: unknown };
            if (frame.type === "next") return [frame.payload];
            if (frame.type === "error") return [{ errors: frame.payload }];
          } catch {
            // Not a protocol frame.
          }
          return [];
        });
        return (payloads.length > 0 ? payloads : [{}]).map((payload) => ({
          stepId: item.stepId,
          query,
          response: payload !== null && typeof payload === "object" ? payload : {},
        }));
      }
      return [
        {
          stepId: item.stepId,
          query,
          response: body !== null && typeof body === "object" ? body : {},
        },
      ];
    } catch {
      return [];
    }
  });
}

const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "a list" : `a ${typeof v}`);

/** Every place the data does not fit the selection's types (REQ-EXEC-48/AC3). */
function dataProblems(schema: GraphQLSchema, doc: DocumentNode, data: unknown): string[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
  // The query passed validation against this schema: it has an operation, and the schema has its root type.
  const operation = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
  const root =
    operation?.kind === Kind.OPERATION_DEFINITION ? schema.getRootType(operation.operation) : undefined;
  if (operation?.kind !== Kind.OPERATION_DEFINITION || !root) return [];
  const problems: string[] = [];

  /** The fields a selection set asks for on a type, by response key. */
  const selected = (
    type: GraphQLObjectType,
    set: SelectionSetNode,
    into = new Map<string, GraphQLField<unknown, unknown> | "__typename">(),
  ) => {
    for (const s of set.selections) {
      if (s.kind === Kind.FIELD) {
        const key = s.alias?.value ?? s.name.value;
        const field = s.name.value === "__typename" ? "__typename" : type.getFields()[s.name.value];
        if (field) into.set(key, field);
        if (field !== undefined && field !== "__typename" && s.selectionSet)
          subsets.set(`${type.name}.${key}`, s.selectionSet);
      } else {
        const fragmentSet =
          s.kind === Kind.INLINE_FRAGMENT ? s.selectionSet : fragments.get(s.name.value)?.selectionSet;
        if (fragmentSet) selected(type, fragmentSet, into);
      }
    }
    return into;
  };
  const subsets = new Map<string, SelectionSetNode>();

  const check = (
    value: unknown,
    type: GraphQLOutputType,
    path: string,
    set: SelectionSetNode | undefined,
    /** The type as the schema declares it at this place, `!` included. */
    declared = String(type),
  ): void => {
    if (isNonNullType(type)) {
      if (value === null || value === undefined) {
        problems.push(`${path} is null, the schema says ${String(type)}`);
        return;
      }
      check(value, type.ofType, path, set, declared);
      return;
    }
    if (value === null || value === undefined) return;
    if (isListType(type)) {
      if (!Array.isArray(value)) {
        problems.push(`${path} is ${kindOf(value)}, the schema says ${declared}`);
        return;
      }
      value.forEach((v, i) => {
        check(v, type.ofType, `${path}.${String(i)}`, set, String(type.ofType));
      });
      return;
    }
    if (isEnumType(type)) {
      if (typeof value !== "string" || !type.getValue(value))
        problems.push(
          `${path} is ${typeof value === "string" ? value : JSON.stringify(value)}, not a value of ${type.name}`,
        );
      return;
    }
    if (isScalarType(type)) {
      const ok =
        type.name === "Int"
          ? Number.isInteger(value)
          : type.name === "Float"
            ? typeof value === "number"
            : type.name === "String"
              ? typeof value === "string"
              : type.name === "Boolean"
                ? typeof value === "boolean"
                : type.name === "ID"
                  ? typeof value === "string" || Number.isInteger(value)
                  : true;
      if (!ok) problems.push(`${path} is ${kindOf(value)}, the schema says ${declared}`);
      return;
    }
    if (isObjectType(type) && set) object(value, type, path, set, declared);
  };

  const object = (
    value: unknown,
    type: GraphQLObjectType,
    path: string,
    set: SelectionSetNode,
    declared = type.name,
  ): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path} is ${kindOf(value)}, the schema says ${declared}`);
      return;
    }
    const fields = selected(type, set);
    for (const [key, v] of Object.entries(value)) {
      const field = fields.get(key);
      if (field === undefined) problems.push(`${path}.${key} was not asked for`);
      else if (field === "__typename") {
        if (typeof v !== "string") problems.push(`${path}.${key} is ${kindOf(v)}, the schema says String!`);
      } else check(v, field.type, `${path}.${key}`, subsets.get(`${type.name}.${key}`));
    }
  };

  object(data, root, "data", operation.selectionSet);
  return problems;
}

/**
 * Checks the GraphQL exchanges of an attempt (REQ-EXEC-48/AC2+AC3), after it ran and before its status is computed.
 * A query that cannot be parsed, does not fit the schema or skips the plan's operation is the spec's error: the
 * attempt errors (BLOCKED). An `errors` array where the step's plan expects data fails the step even with HTTP 200, and
 * data that does not fit the schema of the analysed commit fails it too. A step planned as GraphQL that made no
 * GraphQL call is the spec's error. Only failures are added (invariant 1).
 *
 * @param record - The attempt as the runner recorded it.
 * @param plan - The approved plan.
 * @param schema - The schema of the analysed commit; without it only the `errors` rule applies.
 */
export function checkGraphqlAttempt(
  record: AttemptRecord,
  plan: Plan,
  schema: GraphQLSchema | undefined,
): AttemptRecord {
  const planCase = plan.cases.find((c) => c.id === record.caseId);
  const added: AssertionRecord[] = [];
  const specErrors: string[] = [];
  const all = exchanges(record);
  // A step the plan makes a GraphQL operation must call it with api.graphql() or api.subscribe(), or its errors
  // and its types go unchecked.
  if (record.outcome === "passed" || record.outcome === "failed")
    for (const step of planCase?.steps ?? [])
      if (
        step.graphql !== undefined &&
        record.steps.some((s) => s.id === step.id) &&
        !all.some((ex) => ex.stepId === step.id)
      )
        specErrors.push(
          `${step.id}: the plan's GraphQL operation ${step.graphql.operation} was not called with api.graphql() or api.subscribe()`,
        );
  for (const ex of all) {
    const step = planCase?.steps.find((s) => s.id === ex.stepId);
    let doc: DocumentNode;
    try {
      doc = parse(ex.query);
    } catch (error) {
      specErrors.push(`${ex.stepId}: the GraphQL query cannot be parsed: ${(error as GraphQLError).message}`);
      continue;
    }
    if (schema) {
      const invalid = validate(schema, doc);
      if (invalid.length > 0) {
        specErrors.push(
          `${ex.stepId}: the GraphQL query does not fit the schema: ${invalid.map((e) => e.message).join("; ")}`,
        );
        continue;
      }
    }
    const planned = step?.graphql?.operation;
    if (planned !== undefined) {
      const op = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
      if (op?.kind === Kind.OPERATION_DEFINITION) {
        const kind =
          op.operation === OperationTypeNode.MUTATION
            ? "Mutation"
            : op.operation === OperationTypeNode.SUBSCRIPTION
              ? "Subscription"
              : "Query";
        const asked = op.selectionSet.selections.flatMap((s) =>
          s.kind === Kind.FIELD ? [`${kind}.${s.name.value}`] : [],
        );
        if (!asked.includes(planned))
          specErrors.push(
            `${ex.stepId}: the plan's operation is ${planned}, the query asks for ${asked.join(", ") || "nothing"}`,
          );
      }
    }
    // AC3: errors are part of every result; where the plan expects data they fail the step whatever the HTTP status.
    const errors = Array.isArray(ex.response.errors) ? ex.response.errors : [];
    const expectsErrors = [
      ...Object.keys(step?.expect.fields ?? {}),
      // A subscription's payloads are messages: "0.errors.0.message".
      ...Object.keys(step?.expect.messages ?? {}).map((k) => k.replace(/^\d+\./, "")),
    ].some((f) => f.startsWith("errors"));
    if (errors.length > 0 && !expectsErrors)
      added.push({
        stepId: ex.stepId,
        field: "graphql.errors",
        expected: "no errors",
        actual: errors.map((e) =>
          e !== null && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e),
        ),
        pass: false,
      });
    if (schema && ex.response.data !== undefined && ex.response.data !== null)
      for (const problem of dataProblems(schema, doc, ex.response.data))
        added.push({
          stepId: ex.stepId,
          field: "graphql.schema",
          expected: "data of the schema's types",
          actual: problem,
          pass: false,
        });
  }
  if (specErrors.length > 0)
    return { ...record, outcome: "error", error: [record.error, ...specErrors].filter(Boolean).join("; ") };
  if (added.length === 0) return record;
  return {
    ...record,
    outcome: record.outcome === "passed" ? "failed" : record.outcome,
    assertions: [...record.assertions, ...added],
  };
}
