// The support chat of the demo shop (REQ-EXEC-47 demo): a minimal WebSocket server on /ws/chat, written by hand so
// the demo needs no dependency. Text frames only; BUG-17 drops the customer's words from the reply (see ../BUGS.md).
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One text frame from the server (not masked, at most 64 KiB). */
const frame = (text) => {
  const data = Buffer.from(text, "utf8");
  const head =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
};

/** Text frames in a buffer from the browser (always masked); returns the texts and whether a close frame came. */
const readFrames = (buf) => {
  const texts = [];
  let offset = 0;
  let closed = false;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    let len = buf[offset + 1] & 0x7f;
    let at = offset + 2;
    if (len === 126) {
      len = buf.readUInt16BE(at);
      at += 2;
    } else if (len === 127) return { texts, closed: true };
    const mask = buf.subarray(at, at + 4);
    at += 4;
    if (at + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(at, at + len)).map((b, i) => b ^ mask[i % 4]);
    if (opcode === 0x1) texts.push(payload.toString("utf8"));
    if (opcode === 0x8) closed = true;
    offset = at + len;
  }
  return { texts, closed };
};

/** A close frame with its code and reason. */
const closeFrame = (code, reason) => {
  const data = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, "utf8")]);
  return Buffer.concat([Buffer.from([0x88, data.length]), data]);
};

/** Completes the handshake. */
const accept = (req, socket) => {
  const hash = createHash("sha1")
    .update(String(req.headers["sec-websocket-key"]) + GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`,
  );
};

/**
 * The live price feed (DEMO-20, REQ-EXEC-47/AC1 demo) on /ws/prices, for signed-in clients only: a message
 * `{"subscribe": "<sku>"}` is answered with the price and the availability, then the feed closes with 1000.
 * BUG-28 (BUG_WS_FEED_CLOSES_EARLY) closes it with 1011 after the price.
 */
function prices(socket, products, bugs) {
  socket.on("data", (buf) => {
    const { texts, closed } = readFrames(buf);
    for (const t of texts) {
      let sku;
      try {
        sku = JSON.parse(t).subscribe;
      } catch {
        sku = undefined;
      }
      const product = products.find((p) => p.id === sku);
      if (!product) {
        socket.write(frame(JSON.stringify({ type: "error", message: `Unknown product ${String(sku)}` })));
        continue;
      }
      socket.write(frame(JSON.stringify({ type: "price", sku: product.id, price: product.price })));
      if (bugs.BUG_WS_FEED_CLOSES_EARLY) {
        socket.end(closeFrame(1011, "price feed down"));
        return;
      }
      socket.write(frame(JSON.stringify({ type: "availability", sku: product.id, available: true })));
      socket.end(closeFrame(1000, "done"));
    }
    if (closed) socket.end();
  });
}

/**
 * Handles an HTTP upgrade to the chat or the price feed; other upgrades are refused, and the feed needs a session.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Record<string, boolean>} bugs
 * @param {{ signedIn?: (req: import("node:http").IncomingMessage) => boolean, products?: readonly { id: string, price: number }[] }} [shop]
 */
export function upgradeChat(req, socket, bugs, shop = {}) {
  const key = req.headers["sec-websocket-key"];
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (!["/ws/chat", "/ws/prices"].includes(path) || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  socket.on("error", () => socket.destroy());
  if (path === "/ws/prices") {
    if (!shop.signedIn?.(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    accept(req, socket);
    prices(socket, shop.products ?? [], bugs);
    return;
  }
  accept(req, socket);
  socket.write(frame(JSON.stringify({ type: "hello", text: "Support is online" })));
  socket.on("data", (buf) => {
    const { texts, closed } = readFrames(buf);
    for (const t of texts) {
      let text;
      try {
        text = String(JSON.parse(t).text ?? "");
      } catch {
        text = t;
      }
      const reply = bugs.BUG_CHAT_REPLY_DROPS_TEXT
        ? "Support received your message"
        : `Support received: ${text}`;
      socket.write(frame(JSON.stringify({ type: "reply", text: reply })));
    }
    if (closed) socket.end();
  });
}
