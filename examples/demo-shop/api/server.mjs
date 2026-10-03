#!/usr/bin/env node
// demo-shop REST API: a small, fictional shop used to test QAJitsu itself (REQ-NFR-04).
// Seeded bugs are off by default and switched on with environment flags (see ../BUGS.md).
// Usage: DEMO_USER_PASSWORD=... node api/server.mjs [--port 3000]
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serveWeb } from "./web.mjs";

/** Seeded bug flags (BUGS.md). */
export const BUG_FLAGS = [
  "BUG_CART_TOTAL_ROUNDING",
  "BUG_ORDER_ACCEPTS_NEGATIVE_QTY",
  "BUG_AUTH_EXPIRED_TOKEN_OK",
  "BUG_DISCOUNT_STACKS",
  "BUG_CHECKOUT_BUTTON_DISABLED",
  "BUG_PRICE_FORMAT_LOCALE",
  "BUG_SILENT_500_TOAST",
];

const PRODUCTS = [
  { id: "P-1", name: "Sticker", price: 0.335 },
  { id: "P-2", name: "Mug", price: 24.99 },
  { id: "P-3", name: "T-shirt", price: 59.5 },
];
const DISCOUNTS = { SAVE10: 10, SAVE20: 20 };

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Creates the demo-shop request handler.
 *
 * @param {{ bugs?: Record<string, boolean>, password: string, sha?: string, now?: () => number }} options
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createShop(options) {
  const bugs = Object.fromEntries(BUG_FLAGS.map((f) => [f, options.bugs?.[f] === true]));
  const now = options.now ?? (() => Date.now());
  /** token -> { user, expiresAt, cart: { lines: Map<string, number>, discounts: string[] } } */
  const sessions = new Map();
  let orderSeq = 0;
  /** Seed markers written by `.qa/hooks/seed.mjs` with the QAJitsu run id (stage 6). */
  const seeds = [];

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const session = (req) => {
    const header = req.headers["authorization"] ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const s = sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= now() && !bugs.BUG_AUTH_EXPIRED_TOKEN_OK) return undefined;
    return s;
  };
  const cartView = (cart) => {
    const lines = [...cart.lines.entries()].map(([productId, quantity]) => {
      const product = PRODUCTS.find((p) => p.id === productId);
      return {
        product_id: productId,
        quantity,
        unit_price: product.price,
        line_total: round2(product.price * quantity),
      };
    });
    // BUG-01: rounding each line before summing instead of rounding the sum once.
    const subtotal = bugs.BUG_CART_TOTAL_ROUNDING
      ? lines.reduce((sum, l) => round2(sum + round2(l.unit_price) * l.quantity), 0)
      : round2(lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0));
    const percent = cart.discounts.reduce((p, code) => p + DISCOUNTS[code], 0);
    return { lines, discounts: [...cart.discounts], subtotal, total: round2(subtotal * (1 - percent / 100)) };
  };
  const body = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data === "" ? {} : JSON.parse(data));
        } catch {
          resolve(undefined);
        }
      });
    });

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    if (req.method === "GET" && serveWeb(url.pathname, bugs, res)) return;
    if (route === "GET /health") return json(res, 200, { status: "ok" });
    if (route === "GET /version") return json(res, 200, { sha: options.sha ?? "unknown" });
    if (route === "GET /products") return json(res, 200, PRODUCTS);
    if (route === "POST /auth/login") {
      const input = await body(req);
      const known =
        input && ["standard", "admin"].includes(input.username) && input.password === options.password;
      if (!known) return json(res, 401, { error: "INVALID_CREDENTIALS" });
      const ttl = Number.isInteger(input.ttl_seconds) ? Math.min(Math.max(input.ttl_seconds, 0), 3600) : 3600;
      const token = randomBytes(16).toString("hex");
      const expiresAt = now() + ttl * 1000;
      sessions.set(token, { user: input.username, expiresAt, cart: { lines: new Map(), discounts: [] } });
      return json(res, 200, { token, expires_at: new Date(expiresAt).toISOString() });
    }
    const s = session(req);
    if (!s) return json(res, 401, { error: "UNAUTHORIZED" });
    if (route === "GET /me") return json(res, 200, { username: s.user });
    if (route === "POST /admin/seed" || route === "GET /admin/seed") {
      if (s.user !== "admin") return json(res, 403, { error: "FORBIDDEN" });
      if (req.method === "GET") return json(res, 200, { markers: seeds });
      const input = await body(req);
      if (typeof input?.marker !== "string" || input.marker === "")
        return json(res, 422, { error: "MARKER_REQUIRED" });
      seeds.push(input.marker);
      return json(res, 201, { markers: seeds });
    }
    if (route === "GET /cart") return json(res, 200, cartView(s.cart));
    if (route === "POST /cart/lines") {
      const input = await body(req);
      const product = PRODUCTS.find((p) => p.id === input?.product_id);
      if (!product) return json(res, 404, { error: "PRODUCT_NOT_FOUND" });
      if (!Number.isInteger(input.quantity) || input.quantity < 1)
        return json(res, 422, { error: "INVALID_QUANTITY" });
      s.cart.lines.set(product.id, (s.cart.lines.get(product.id) ?? 0) + input.quantity);
      return json(res, 201, cartView(s.cart));
    }
    if (route === "POST /cart/discount") {
      const input = await body(req);
      const code = input?.code;
      if (typeof code !== "string" || !(code in DISCOUNTS))
        return json(res, 404, { error: "DISCOUNT_NOT_FOUND" });
      // BUG-04: codes stack instead of the second replacing the first.
      s.cart.discounts = bugs.BUG_DISCOUNT_STACKS ? [...new Set([...s.cart.discounts, code])] : [code];
      return json(res, 200, cartView(s.cart));
    }
    if (route === "POST /orders") {
      const input = await body(req);
      const product = PRODUCTS.find((p) => p.id === input?.product_id);
      if (!product) return json(res, 404, { error: "PRODUCT_NOT_FOUND" });
      // BUG-02: negative quantities are accepted.
      const q = input.quantity;
      const valid = Number.isInteger(q) && (q >= 1 || (bugs.BUG_ORDER_ACCEPTS_NEGATIVE_QTY && q < 0));
      if (!valid) return json(res, 422, { error: "INVALID_QUANTITY" });
      orderSeq += 1;
      return json(res, 201, {
        id: `O-${String(orderSeq)}`,
        product_id: product.id,
        quantity: q,
        total: round2(product.price * q),
      });
    }
    if (route === "POST /checkout") {
      const input = await body(req);
      // BUG-07: the API fails, the UI still reports success (see web.mjs).
      if (bugs.BUG_SILENT_500_TOAST) return json(res, 500, { error: "INTERNAL" });
      if (input?.accept_terms !== true) return json(res, 422, { error: "TERMS_NOT_ACCEPTED" });
      if (s.cart.lines.size === 0) return json(res, 422, { error: "CART_EMPTY" });
      orderSeq += 1;
      const order = { id: `O-${String(orderSeq)}`, total: cartView(s.cart).total };
      s.cart = { lines: new Map(), discounts: [] };
      return json(res, 201, order);
    }
    return json(res, 404, { error: "NOT_FOUND" });
  };
}

/**
 * Starts the server; flags come from the environment (`BUG_*=1`).
 *
 * @param {{ port?: number, host?: string, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startShop(options = {}) {
  const env = options.env ?? process.env;
  const password = env.DEMO_USER_PASSWORD;
  if (!password) throw new Error("Set DEMO_USER_PASSWORD (see examples/demo-shop/.env.example).");
  const bugs = Object.fromEntries(BUG_FLAGS.map((f) => [f, env[f] === "1" || env[f] === "true"]));
  const handler = createShop({ bugs, password, sha: env.DEMO_SHA });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://${options.host === "0.0.0.0" || options.host === undefined ? "127.0.0.1" : options.host}:${String(address.port)}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const h = process.argv.indexOf("--host");
  const shop = await startShop({
    port: i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT ?? 3000),
    // Inside a container the API must listen on all interfaces (docker-compose.yml passes --host 0.0.0.0).
    host: h > 0 ? process.argv[h + 1] : "127.0.0.1",
  });
  const on = BUG_FLAGS.filter((f) => process.env[f] === "1" || process.env[f] === "true");
  process.stdout.write(
    `demo-shop API on ${shop.url}${on.length > 0 ? ` (bugs on: ${on.join(", ")})` : ""}\n`,
  );
}
