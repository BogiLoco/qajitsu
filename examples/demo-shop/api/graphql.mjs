// A small GraphQL endpoint of the demo shop (DEMO-18, REQ-EXEC-48 demo), without dependencies so the shop also runs
// from a bare worktree: queries over products with arguments, variables and nested selections. Seeded bugs:
// BUG_GRAPHQL_PRICE_AS_TEXT answers the price as a string; BUG_GRAPHQL_ERROR_WITH_DATA adds an error next to the
// product list, with HTTP 200.

/** Tokens of a GraphQL document: names, punctuation, strings and numbers. */
function tokenize(source) {
  const tokens = [];
  const re =
    /\s+|,|#[^\n]*|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)|([_A-Za-z][_0-9A-Za-z]*)|(\.\.\.|[{}():$!=[\]])/gy;
  let m;
  while (re.lastIndex < source.length && (m = re.exec(source)) !== null) {
    if (m[1] !== undefined) tokens.push({ kind: "string", value: JSON.parse(`"${m[1]}"`) });
    else if (m[2] !== undefined) tokens.push({ kind: "number", value: Number(m[2]) });
    else if (m[3] !== undefined) tokens.push({ kind: "name", value: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: "punct", value: m[4] });
  }
  if (re.lastIndex < source.length)
    throw new Error(`Syntax Error: unexpected character at ${String(re.lastIndex)}`);
  return tokens;
}

/** Parses the first operation: `[query|mutation] [Name] [(variables)] { selections }`. */
function parseOperation(source) {
  const t = tokenize(source);
  let i = 0;
  const peek = () => t[i];
  const take = (value) => {
    const tok = t[i];
    if (tok === undefined || (value !== undefined && tok.value !== value))
      throw new Error(`Syntax Error: expected ${value ?? "a token"}`);
    i += 1;
    return tok;
  };
  const value = () => {
    const tok = take();
    if (tok.value === "$") return { variable: take().value };
    return tok.value;
  };
  const selections = () => {
    take("{");
    const out = [];
    while (peek()?.value !== "}") {
      const name = take().value;
      const args = {};
      if (peek()?.value === "(") {
        take("(");
        while (peek()?.value !== ")") {
          const key = take().value;
          take(":");
          args[key] = value();
        }
        take(")");
      }
      out.push({ name, args, ...(peek()?.value === "{" ? { selections: selections() } : {}) });
    }
    take("}");
    return out;
  };
  let operation = "query";
  if (peek()?.value === "query" || peek()?.value === "mutation") operation = take().value;
  if (peek()?.kind === "name") take();
  if (peek()?.value === "(") {
    while (peek()?.value !== ")") take();
    take(")");
  }
  return { operation, selections: selections() };
}

/** The selected fields of an object. */
function pick(object, selections) {
  const out = {};
  for (const s of selections) out[s.name] = s.name === "__typename" ? "Product" : object[s.name];
  return out;
}

/**
 * Answers a GraphQL request of the shop.
 *
 * @param {{ query?: unknown, variables?: Record<string, unknown> }} body
 * @param {readonly { id: string, name: string, price: number }[]} products
 * @param {Record<string, boolean>} bugs
 */
export function answerGraphql(body, products, bugs) {
  if (typeof body?.query !== "string") return { errors: [{ message: "Must provide query string." }] };
  let op;
  try {
    op = parseOperation(body.query);
  } catch (error) {
    return { errors: [{ message: error.message }] };
  }
  const variables = body.variables ?? {};
  const arg = (a) => (a !== null && typeof a === "object" && "variable" in a ? variables[a.variable] : a);
  const shape = (p) => ({
    id: p.id,
    name: p.name,
    price: bugs.BUG_GRAPHQL_PRICE_AS_TEXT ? p.price.toFixed(2) : p.price,
    inStock: p.id !== "P-3",
  });
  const data = {};
  const errors = [];
  for (const s of op.selections) {
    if (op.operation !== "query") {
      errors.push({ message: `Schema is not configured for ${op.operation}s.` });
      continue;
    }
    if (s.name === "product") {
      const p = products.find((x) => x.id === String(arg(s.args.id)));
      data.product = p ? pick(shape(p), s.selections ?? []) : null;
    } else if (s.name === "products") {
      data.products = products.map((p) => pick(shape(p), s.selections ?? []));
      if (bugs.BUG_GRAPHQL_ERROR_WITH_DATA)
        errors.push({ message: "Price cache unavailable", path: ["products"] });
    } else errors.push({ message: `Cannot query field "${s.name}" on type "Query".` });
  }
  return errors.length > 0 ? { data, errors } : { data };
}
