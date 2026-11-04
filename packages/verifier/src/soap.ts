import { ConfigError, type AssertionRecord, type AttemptRecord, type Plan } from "@qajitsu/core";
import { parseXml, soapFault } from "@qajitsu/steps";
import { XMLSerializer, type Element, type Node } from "@xmldom/xmldom";
import { validateXML } from "xmllint-wasm";

const XSD = "http://www.w3.org/2001/XMLSchema";

const childElements = (el: Element): Element[] => {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
};

const descendants = (el: Element, localName: string): Element[] =>
  Array.from(el.getElementsByTagNameNS("*", localName));

/**
 * The operations a WSDL 1.1 (`portType`) or 2.0 (`interface`) describes, for the planner (REQ-EXEC-50/AC1).
 *
 * @param wsdl - The WSDL text from the repository.
 * @throws {ConfigError} `WSDL_INVALID` when the text is not a WSDL.
 */
export function wsdlOperations(wsdl: string): string[] {
  const root = parseXml(wsdl);
  if (!root || !["definitions", "description"].includes(String(root.localName)))
    throw new ConfigError(
      "WSDL_INVALID",
      "The WSDL cannot be read: it is not a WSDL 1.1 or 2.0 document",
      {},
    );
  const names = descendants(root, "operation")
    .filter((op) => ["portType", "interface"].includes(String((op.parentNode as Element).localName)))
    .map((op) => op.getAttribute("name") ?? "")
    .filter((n) => n !== "");
  return [...new Set(names)];
}

/** Checks one XML element against the contract; returns its problems (empty when it fits). */
export type XmlValidator = (xml: string) => Promise<string[]>;

/** The schemas inside a WSDL's `types`, each a document of its own that keeps the namespaces declared above it. */
function wsdlSchemas(wsdl: string): string[] {
  const root = parseXml(wsdl);
  if (!root) throw new ConfigError("WSDL_INVALID", "The WSDL cannot be read: it is not XML", {});
  return Array.from(root.getElementsByTagNameNS(XSD, "schema")).map((schema) => {
    const text = new XMLSerializer().serializeToString(schema);
    const tag = text.slice(0, text.indexOf(">") + 1);
    const inherited = new Map<string, string>();
    for (
      let p: Node | null = schema.parentNode;
      p !== null && p.nodeType === p.ELEMENT_NODE;
      p = p.parentNode
    )
      for (const attr of Array.from((p as Element).attributes))
        if ((attr.name === "xmlns" || attr.name.startsWith("xmlns:")) && !inherited.has(attr.name))
          inherited.set(attr.name, attr.value);
    const missing = [...inherited]
      .filter(([name]) => !new RegExp(`\\s${name}=`).test(tag))
      .map(([name, value]) => ` ${name}="${value.replace(/"/g, "&quot;")}"`)
      .join("");
    return text.replace(/^(<[^\s>/]+)/, `$1${missing}`);
  });
}

/**
 * A validator for the XML schemas of the analysed commit (REQ-EXEC-50/AC2): those in the WSDL's `types` and in the
 * repository's XSD files, joined by one schema that imports each by its target namespace.
 *
 * @param input - The WSDL text and the XSD texts.
 * @throws {ConfigError} `WSDL_INVALID` when the WSDL is not XML, `XSD_INVALID` when an XSD is not a schema.
 */
export function createXmlValidator(input: {
  readonly wsdl?: string;
  readonly xsd?: readonly string[];
}): XmlValidator {
  const schemas = [...(input.wsdl === undefined ? [] : wsdlSchemas(input.wsdl)), ...(input.xsd ?? [])];
  const files = schemas.map((contents, i) => {
    const root = parseXml(contents);
    if (root?.localName !== "schema" || root.namespaceURI !== XSD)
      throw new ConfigError("XSD_INVALID", `XML schema ${String(i + 1)} is not an XSD document`, {});
    return {
      fileName: `schema-${String(i + 1)}.xsd`,
      contents,
      namespace: root.getAttribute("targetNamespace"),
    };
  });
  const main = `<xs:schema xmlns:xs="${XSD}">${files
    .map((f) =>
      f.namespace
        ? `<xs:import namespace="${f.namespace}" schemaLocation="${f.fileName}"/>`
        : `<xs:include schemaLocation="${f.fileName}"/>`,
    )
    .join("")}</xs:schema>`;
  return async (xml) => {
    if (files.length === 0) return [];
    const result = await validateXML({
      xml: [{ fileName: "response.xml", contents: xml }],
      schema: [{ fileName: "contract.xsd", contents: main }],
      preload: files.map(({ fileName, contents }) => ({ fileName, contents })),
    });
    return result.valid ? [] : result.errors.map((e) => e.message.replace(/^Schemas validity error : /, ""));
  };
}

/** One SOAP or XML exchange of an attempt, read from its call record. */
interface Exchange {
  readonly stepId: string;
  /** A call made with api.soap(), or another call whose answer is XML. */
  readonly soap: boolean;
  readonly action?: string;
  readonly request?: string;
  readonly response: string;
}

function exchanges(record: AttemptRecord): Exchange[] {
  return record.evidence.flatMap((item): Exchange[] => {
    if (typeof item.content !== "string") return [];
    try {
      const call = JSON.parse(item.content) as {
        soap?: { action?: unknown };
        request?: { body?: { soap?: { envelope?: unknown } } };
        response?: { headers?: Record<string, unknown>; body?: unknown };
      };
      const body = call.response?.body;
      // Only calls made with api.soap() are SOAP; the runtime in the trusted parent marks them.
      if (call.soap === undefined) {
        const header = call.response?.headers?.["content-type"];
        const type = typeof header === "string" ? header : "";
        return /[/+]xml\b/.test(type) && typeof body === "string"
          ? [{ stepId: item.stepId, soap: false, response: body }]
          : [];
      }
      const envelope = call.request?.body?.soap?.envelope;
      return [
        {
          stepId: item.stepId,
          soap: true,
          ...(typeof call.soap.action === "string" ? { action: call.soap.action } : {}),
          ...(typeof envelope === "string" ? { request: envelope } : {}),
          // A JSON answer to a SOAP call is kept as its text: it is not XML, which the schema check reports.
          response: typeof body === "string" ? body : JSON.stringify(body ?? null),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** The first element of a SOAP envelope's body, or the document element of plain XML. */
function payloadOf(xml: string): Element | undefined {
  const root = parseXml(xml);
  if (!root) return undefined;
  if (root.localName !== "Envelope") return root;
  const body = childElements(root).find((e) => e.localName === "Body");
  return body ? childElements(body)[0] : undefined;
}

/** Adds a failed `soap.schema` assertion for every place the answer does not fit the schemas. */
async function schemaCheck(ex: Exchange, validator: XmlValidator, added: AssertionRecord[]): Promise<void> {
  const payload = payloadOf(ex.response);
  const problems = payload
    ? await validator(new XMLSerializer().serializeToString(payload))
    : ["the answer is not XML, or its body is empty"];
  for (const problem of problems)
    added.push({
      stepId: ex.stepId,
      field: "soap.schema",
      expected: "an answer of the WSDL's or XSD's types",
      actual: problem,
      pass: false,
    });
}

/**
 * The global elements an XSD declares, for the planner (REQ-EXEC-50/AC1).
 *
 * @param xsd - The XSD text.
 * @throws {ConfigError} `XSD_INVALID` when it is not an XSD document.
 */
export function xsdElements(xsd: string): string[] {
  const root = parseXml(xsd);
  if (root?.localName !== "schema" || root.namespaceURI !== XSD)
    throw new ConfigError("XSD_INVALID", "The XML schema is not an XSD document", {});
  return childElements(root)
    .filter((e) => e.localName === "element")
    .map((e) => e.getAttribute("name") ?? "")
    .filter((n) => n !== "");
}

/**
 * Checks the SOAP exchanges of an attempt (REQ-EXEC-50/AC1+AC2), after it ran and before its status is computed. A
 * request whose body element is neither the plan's operation nor named by its action is the spec's error: the attempt
 * errors (BLOCKED). A fault where the plan expects an answer fails the step even with HTTP 200, and an answer that
 * does not fit the WSDL or XSD of the analysed commit fails it too. A step expects a fault when it plans HTTP 500 or
 * an XPath on `Fault`. Other calls whose answer is XML are checked against the schemas only. A step planned as SOAP that made no SOAP call is the spec's error too. Only failures are added
 * (invariant 1).
 *
 * @param record - The attempt as the runner recorded it.
 * @param plan - The approved plan.
 * @param validator - The schemas of the analysed commit; without it only the fault rule applies.
 */
export async function checkSoapAttempt(
  record: AttemptRecord,
  plan: Plan,
  validator: XmlValidator | undefined,
): Promise<AttemptRecord> {
  const planCase = plan.cases.find((c) => c.id === record.caseId);
  const added: AssertionRecord[] = [];
  const specErrors: string[] = [];
  const all = exchanges(record);
  for (const ex of all) {
    const step = planCase?.steps.find((s) => s.id === ex.stepId);
    // REQ-EXEC-50/AC2: a plain XML answer is checked against the XSD; faults and operations are SOAP's.
    if (!ex.soap) {
      if (validator) await schemaCheck(ex, validator, added);
      continue;
    }
    const planned = step?.soap?.operation;
    const sent = ex.request === undefined ? undefined : payloadOf(ex.request)?.localName;
    if (planned !== undefined && sent !== planned && !(ex.action ?? "").endsWith(planned))
      specErrors.push(
        `${ex.stepId}: the plan's operation is ${planned}, the request sends ${sent ?? "nothing"}${ex.action ? ` (action ${ex.action})` : ""}`,
      );
    const fault = soapFault(ex.response);
    const expectsFault =
      step?.expect.status === 500 || Object.keys(step?.expect.xml ?? {}).some((x) => /Fault|fault/.test(x));
    if (fault !== undefined && !expectsFault)
      added.push({
        stepId: ex.stepId,
        field: "soap.fault",
        expected: "no fault",
        actual: fault,
        pass: false,
      });
    if (fault === undefined && validator) await schemaCheck(ex, validator, added);
  }
  // A step the plan makes a SOAP call must make it with api.soap(), or its fault and its types go unchecked.
  if (record.outcome === "passed" || record.outcome === "failed")
    for (const step of planCase?.steps ?? [])
      if (
        step.soap !== undefined &&
        record.steps.some((s) => s.id === step.id) &&
        !all.some((ex) => ex.soap && ex.stepId === step.id)
      )
        specErrors.push(
          `${step.id}: the plan's SOAP operation ${step.soap.operation} was not called with api.soap()`,
        );
  if (specErrors.length > 0)
    return { ...record, outcome: "error", error: [record.error, ...specErrors].filter(Boolean).join("; ") };
  if (added.length === 0) return record;
  return {
    ...record,
    outcome: record.outcome === "passed" ? "failed" : record.outcome,
    assertions: [...record.assertions, ...added],
  };
}
