// A fictional identity provider for the demo shop's single sign-on (REQ-EXEC-55 demo): a login page on its own
// origin asks for the username, the password and a TOTP code, then sends the browser back to the shop with a ticket
// the shop redeems server to server. It knows one test user; nothing here is a real provider.
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32 = (s) => {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.replace(/[\s=]/g, "").toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** The six-digit code of a seed at a time (RFC 6238, SHA-1, 30 s). */
export const totpAt = (seed, ms) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac("sha1", base32(seed)).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};

/**
 * Starts the identity provider.
 *
 * @param {{ password: string, totpSeed: string, port?: number }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startIdp(options) {
  const tickets = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://idp.local");
    if (req.method === "GET" && url.pathname === "/authorize") {
      const back = url.searchParams.get("redirect_uri") ?? "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Demo IdP</title></head><body style="font:15px system-ui">
<h1>Demo IdP</h1><form method="post" action="/authorize"><input type="hidden" name="redirect_uri" value="${back.replace(/"/g, "&quot;")}">
<p><label>Username <input name="username" autocomplete="username"></label></p>
<p><label>Password <input type="password" name="password"></label></p>
<p><label>Code <input name="code" inputmode="numeric"></label></p>
<p><button>Sign in</button></p></form></body></html>`);
      return;
    }
    if (req.method === "POST" && url.pathname === "/authorize") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const now = Date.now();
        const codeOk = [now - 30_000, now, now + 30_000].some(
          (t) => totpAt(options.totpSeed, t) === f.get("code"),
        );
        const back = f.get("redirect_uri") ?? "";
        if (f.get("username") !== "standard" || f.get("password") !== options.password || !codeOk) {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(`<p data-testid="idp-error">Sign-in failed</p>`);
          return;
        }
        const ticket = randomBytes(12).toString("hex");
        tickets.set(ticket, "standard");
        res.writeHead(302, { location: `${back}${back.includes("?") ? "&" : "?"}ticket=${ticket}` });
        res.end();
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/ticket/")) {
      const user = tickets.get(url.pathname.slice(8));
      tickets.delete(url.pathname.slice(8));
      res.writeHead(user ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(user ? { username: user } : { error: "UNKNOWN_TICKET" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
