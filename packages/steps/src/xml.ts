import { createRequire } from "node:module";
import { DOMParser, type Attr, type Element, type Node } from "@xmldom/xmldom";

// Loaded untyped: the package's types pull the DOM library into every program that imports this one.
const xpath = createRequire(import.meta.url)("xpath") as {
  select: (expression: string, node: Node, single?: boolean) => unknown;
};

/** The XML with namespace prefixes and declarations removed, so XPath addresses local names (REQ-EXEC-50/AC3). */
function localNames(xml: string): string {
  return xml
    .replace(/\s+xmlns(:[\w.-]+)?\s*=\s*("[^"]*"|'[^']*')/g, "")
    .replace(/(<\/?|\s)[\w.-]+:(?=[\w.-]+[\s=/>])/g, "$1");
}

/**
 * The root element of an XML text (REQ-EXEC-50), or undefined when it is not well-formed XML: any error or warning of
 * the parser, a fatal one included, means the text is not XML.
 *
 * @param text - The XML text.
 */
export function parseXml(text: string): Element | undefined {
  if (!/^\s*</.test(text)) return undefined;
  const problems: string[] = [];
  try {
    const doc = new DOMParser({ onError: (level: string) => problems.push(level) }).parseFromString(
      text,
      "text/xml",
    );
    return problems.length === 0 ? (doc.documentElement ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The value of an XPath over the local names of an XML or SOAP response (REQ-EXEC-50/AC3): a number, string or
 * boolean the expression computes, otherwise the text of its first node (an element's text, an attribute's value);
 * undefined when nothing matches, the body is not XML or the expression is not XPath.
 *
 * @param xml - The response body.
 * @param expression - XPath 1.0, written without namespace prefixes.
 */
export function xmlValue(xml: string, expression: string): unknown {
  const doc = parseXml(localNames(xml))?.ownerDocument;
  if (!doc) return undefined;
  let result: unknown;
  try {
    result = xpath.select(expression, doc);
  } catch {
    return undefined;
  }
  if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") return result;
  // Anything else XPath answers is a list of nodes.
  const first = (result as Node[])[0];
  if (first === undefined) return undefined;
  return (first.nodeType === 2 ? (first as Attr).value : (first.textContent ?? "")).trim();
}

const ENVELOPES = {
  "1.1": "http://schemas.xmlsoap.org/soap/envelope/",
  "1.2": "http://www.w3.org/2003/05/soap-envelope",
} as const;

/**
 * A SOAP request of the given version around a body element (REQ-EXEC-50/AC1).
 *
 * @param body - The body's XML, e.g. `<GetPrice xmlns="urn:shop:prices"><sku>P-2</sku></GetPrice>`.
 * @param version - SOAP 1.1 (default) or 1.2.
 */
export function soapEnvelope(body: string, version: "1.1" | "1.2"): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${ENVELOPES[version]}"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

/**
 * The fault of a SOAP response as `<code>: <text>` (REQ-EXEC-50/AC2), from SOAP 1.1 (`faultcode`, `faultstring`)
 * or 1.2 (`Code/Value`, `Reason/Text`); `fault` when it has neither; undefined when there is no fault.
 *
 * @param xml - The response body.
 */
export function soapFault(xml: string): string | undefined {
  const doc = parseXml(localNames(xml))?.ownerDocument;
  if (!doc || xpath.select("//Fault", doc, true) === undefined) return undefined;
  const text = (expression: string): string => String(xpath.select(`string(${expression})`, doc)).trim();
  // The codes keep their prefix: they are QNames the service chose (s:Server, e:Receiver).
  const raw = (expression: string): string => {
    const m = new RegExp(`<(?:[\\w.-]+:)?${expression}>\\s*([^<]*)<`).exec(xml);
    return m?.[1]?.trim() ?? "";
  };
  const code = raw("faultcode") || raw("Value");
  const reason = text("//Fault/faultstring") || text("//Fault/Reason/Text");
  return [code, reason].filter((s) => s !== "").join(": ") || "fault";
}
