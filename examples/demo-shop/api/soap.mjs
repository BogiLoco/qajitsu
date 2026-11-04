// The SOAP 1.1 price service of the demo shop (DEMO-19, REQ-EXEC-50 demo), without dependencies so the shop also runs
// from a bare worktree. Seeded bugs: BUG_SOAP_CURRENCY_MISSING leaves out the currency the WSDL requires;
// BUG_SOAP_FAULT_WITH_200 answers a price below 1 with a fault, still with HTTP 200.

const ENVELOPE = "http://schemas.xmlsoap.org/soap/envelope/";
const NS = "urn:demo-shop:prices";

const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const envelope = (body) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${ENVELOPE}"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const fault = (code, text) =>
  envelope(
    `<soap:Fault><faultcode>soap:${code}</faultcode><faultstring>${escape(text)}</faultstring></soap:Fault>`,
  );

/**
 * The answer to one SOAP request: `{ status, xml }`.
 *
 * @param {string} text - The request body.
 * @param {readonly { id: string; name: string; price: number }[]} products
 * @param {Record<string, boolean>} bugs
 */
export function answerSoap(text, products, bugs) {
  const body = /<(?:[\w.-]+:)?Body[^>]*>\s*<(?:[\w.-]+:)?([\w.-]+)[\s>/]/.exec(text);
  if (!body) return { status: 500, xml: fault("Client", "Not a SOAP envelope") };
  if (body[1] !== "GetPrice") return { status: 500, xml: fault("Client", `Unknown operation ${body[1]}`) };
  const sku = /<(?:[\w.-]+:)?sku>\s*([^<]*?)\s*<\//.exec(text)?.[1];
  const product = products.find((p) => p.id === sku);
  if (!product) return { status: 500, xml: fault("Client", `Unknown product ${sku ?? ""}`) };
  // BUG-27: a fault for a cheap product, answered as if it were a success.
  if (bugs.BUG_SOAP_FAULT_WITH_200 && product.price < 1)
    return { status: 200, xml: fault("Server", "Price below the minimum") };
  // BUG-26: the currency the WSDL requires is left out.
  const currency = bugs.BUG_SOAP_CURRENCY_MISSING ? "" : ' currency="EUR"';
  return {
    status: 200,
    xml: envelope(
      `<p:GetPriceResponse xmlns:p="${NS}"${currency}><p:sku>${escape(product.id)}</p:sku><p:name>${escape(product.name)}</p:name><p:amount>${String(product.price)}</p:amount></p:GetPriceResponse>`,
    ),
  };
}
