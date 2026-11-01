import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlaywrightTransport } from "./transport.js";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x81]);

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });

describe("API transport bodies (REQ-EXEC-45)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      void read(req).then((body) => {
        if (req.url === "/file") {
          res.writeHead(200, {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="r.pdf"',
          });
          res.end(PDF);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: req.headers["content-type"] ?? "", body: body.toString("latin1") }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("REQ-EXEC-45/AC1: multipart, form and raw bytes reach the server as such; REQ-EXEC-45/AC2: file responses keep their bytes", async () => {
    const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
    try {
      const echo = async (payload: NonNullable<Parameters<typeof transport>[0]["payload"]>, headers = {}) =>
        JSON.parse((await transport({ method: "POST", url: `${base}/echo`, headers, payload })).text) as {
          type: string;
          body: string;
        };
      const multipart = await echo({
        kind: "multipart",
        fields: { title: "Invoice" },
        files: { document: { name: "invoice.pdf", type: "application/pdf", data: new Uint8Array(PDF) } },
      });
      expect(multipart.type).toMatch(/^multipart\/form-data; boundary=/);
      expect(multipart.body).toContain('name="title"\r\n\r\nInvoice');
      expect(multipart.body).toMatch(
        /name="document"; filename="invoice\.pdf"\r\ncontent-type: application\/pdf/i,
      );
      expect(multipart.body).toContain(PDF.toString("latin1"));
      const form = await echo({ kind: "form", fields: { user: "anna", q: "a b&c" } });
      expect(form.type).toBe("application/x-www-form-urlencoded");
      expect(form.body).toBe("user=anna&q=a+b%26c");
      const raw = await echo(
        { kind: "bytes", data: new Uint8Array(PDF), type: "application/pdf" },
        {
          "content-type": "application/pdf",
        },
      );
      expect(raw.type).toBe("application/pdf");
      expect(raw.body).toBe(PDF.toString("latin1"));
      const file = await transport({ method: "GET", url: `${base}/file`, headers: {} });
      expect(Buffer.from(file.bytes ?? new Uint8Array())).toEqual(PDF);
      expect(file.headers["content-disposition"]).toContain("r.pdf");
    } finally {
      await dispose();
    }
  });
});
