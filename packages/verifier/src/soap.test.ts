import { ConfigError, PlanSchema, type AttemptRecord, type EvidenceItem } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkSoapAttempt, createXmlValidator, wsdlOperations, xsdElements } from "./soap.js";

const WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:tns="urn:shop:prices" targetNamespace="urn:shop:prices">
  <wsdl:types>
    <xs:schema targetNamespace="urn:shop:prices" elementFormDefault="qualified">
      <xs:element name="GetPrice"><xs:complexType><xs:sequence><xs:element name="sku" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="GetPriceResponse">
        <xs:complexType>
          <xs:sequence><xs:element name="amount" type="xs:decimal"/><xs:element name="stock" type="tns:Stock"/></xs:sequence>
          <xs:attribute name="currency" type="xs:string" use="required"/>
        </xs:complexType>
      </xs:element>
      <xs:simpleType name="Stock"><xs:restriction base="xs:string"><xs:enumeration value="in"/><xs:enumeration value="out"/></xs:restriction></xs:simpleType>
    </xs:schema>
  </wsdl:types>
  <wsdl:message name="GetPriceIn"><wsdl:part name="p" element="tns:GetPrice"/></wsdl:message>
  <wsdl:portType name="Prices">
    <wsdl:operation name="GetPrice"><wsdl:input message="tns:GetPriceIn"/></wsdl:operation>
    <wsdl:operation name="SetPrice"/>
  </wsdl:portType>
  <wsdl:binding name="PricesSoap" type="tns:Prices"><wsdl:operation name="GetPrice"/></wsdl:binding>
</wsdl:definitions>`;

const XSD = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Ping" type="xs:int"/></xs:schema>`;

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-19",
  version: 1,
  summary: "Prices over SOAP.",
  cases: [
    {
      id: "TC-01",
      title: "A price is read",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "POST /soap/prices",
          soap: { operation: "GetPrice" },
          expect: { description: "Priced", status: 200, xml: { "//amount": 24.99 } },
        },
        {
          id: "S2",
          action: "POST /soap/prices",
          soap: { operation: "GetPrice" },
          expect: { description: "Unknown SKU", status: 500, xml: { "//Fault/faultstring": "Unknown SKU" } },
        },
      ],
      evidence: ["request", "response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const envelope = (body: string) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const REQUEST = envelope('<GetPrice xmlns="urn:shop:prices"><sku>P-2</sku></GetPrice>');
const ANSWER = envelope(
  '<p:GetPriceResponse xmlns:p="urn:shop:prices" currency="EUR"><p:amount>24.99</p:amount><p:stock>in</p:stock></p:GetPriceResponse>',
);
const FAULT = envelope(
  "<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown SKU</faultstring></soap:Fault>",
);

const exchange = (stepId: string, response: unknown, request = REQUEST, action?: string): EvidenceItem => ({
  name: `${stepId}-01.json`,
  kind: "response",
  stepId,
  content: JSON.stringify({
    method: "POST",
    url: "http://127.0.0.1:3000/soap/prices",
    soap: { version: "1.1", ...(action ? { action } : {}) },
    request: { headers: {}, body: { soap: { version: "1.1", envelope: request } } },
    response: { status: 200, headers: {}, body: response },
  }),
});

const attempt = (...evidence: EvidenceItem[]): AttemptRecord => ({
  caseId: "TC-01",
  attempt: 1,
  outcome: "passed",
  steps: [...new Set(evidence.map((e) => e.stepId))].map((id) => ({ id, ok: true })),
  assertions: [{ stepId: "S1", field: "xml.//amount", expected: 24.99, actual: 24.99, pass: true }],
  evidence,
});

const validator = createXmlValidator({ wsdl: WSDL, xsd: [XSD] });

describe("SOAP and XML contracts (REQ-EXEC-50)", () => {
  it("REQ-EXEC-50/AC1: the operations of a WSDL 1.1 or 2.0 are listed for the planner", () => {
    expect(wsdlOperations(WSDL)).toEqual(["GetPrice", "SetPrice"]);
    expect(
      wsdlOperations(
        '<description xmlns="http://www.w3.org/ns/wsdl"><interface name="I"><operation name="Track"/></interface></description>',
      ),
    ).toEqual(["Track"]);
    expect(
      wsdlOperations(
        '<description xmlns="http://www.w3.org/ns/wsdl"><interface>\n  <operation/>\n  <operation name="A"/></interface></description>',
      ),
    ).toEqual(["A"]);
    expect(() => wsdlOperations("<html/>")).toThrow(ConfigError);
    expect(() => wsdlOperations("not xml")).toThrow(/WSDL/);
  });

  it("REQ-EXEC-50/AC2: an answer of the WSDL's types changes nothing; a plain XML answer is checked by the XSD", async () => {
    const record = attempt(exchange("S1", ANSWER));
    expect(await checkSoapAttempt(record, plan, validator)).toEqual(record);
    expect(await validator("<Ping>4</Ping>")).toEqual([]);
    expect((await validator("<Ping>four</Ping>")).join()).toContain("'four' is not a valid value");
  });

  it("REQ-EXEC-50/AC2: an answer that does not fit the schemas of the analysed commit fails the step", async () => {
    const broken = ANSWER.replace(' currency="EUR"', "").replace("24.99", "cheap").replace(">in<", ">maybe<");
    const checked = await checkSoapAttempt(attempt(exchange("S1", broken)), plan, validator);
    expect(checked.outcome).toBe("failed");
    const problems = checked.assertions.filter((a) => a.field === "soap.schema").map((a) => String(a.actual));
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/'cheap' is not a valid value of the atomic type 'xs:decimal'/);
    expect(problems.join("\n")).toMatch(/currency.*is required/);
    expect(problems.join("\n")).toMatch(/maybe/);
    const unknown = await checkSoapAttempt(attempt(exchange("S1", envelope("<Other/>"))), plan, validator);
    expect(unknown.assertions.at(-1)?.actual).toMatch(/No matching global declaration/);
    const empty = await checkSoapAttempt(attempt(exchange("S1", envelope(""))), plan, validator);
    expect(empty.assertions.at(-1)?.actual).toBe("the answer is not XML, or its body is empty");
  });

  it("REQ-EXEC-50/AC2: a fault where the plan expects an answer fails the step even with HTTP 200; a planned fault does not", async () => {
    const unexpected = await checkSoapAttempt(attempt(exchange("S1", FAULT)), plan, undefined);
    expect(unexpected.outcome).toBe("failed");
    expect(unexpected.assertions).toContainEqual({
      stepId: "S1",
      field: "soap.fault",
      expected: "no fault",
      actual: "soap:Client: Unknown SKU",
      pass: false,
    });
    const planned = attempt(exchange("S2", FAULT));
    expect(await checkSoapAttempt(planned, plan, validator)).toEqual(planned);
  });

  it("REQ-EXEC-50/AC1: a request that does not send the plan's operation is the spec's error: BLOCKED", async () => {
    const other = await checkSoapAttempt(
      attempt(exchange("S1", ANSWER, envelope('<SetPrice xmlns="urn:shop:prices"/>'))),
      plan,
      validator,
    );
    expect(other.outcome).toBe("error");
    expect(other.error).toBe("S1: the plan's operation is GetPrice, the request sends SetPrice");
    const byAction = attempt(exchange("S1", ANSWER, envelope("<Wrapped/>"), "urn:shop:prices#GetPrice"));
    expect((await checkSoapAttempt(byAction, plan, validator)).outcome).toBe("passed");
    const none = await checkSoapAttempt(attempt(exchange("S1", ANSWER, "garbage", "X")), plan, undefined);
    expect(none.error).toBe("S1: the plan's operation is GetPrice, the request sends nothing (action X)");
  });

  it("REQ-EXEC-50/AC1: a step planned as SOAP that sends its envelope another way is the spec's error: BLOCKED", async () => {
    const plain: EvidenceItem = {
      name: "S1-01.json",
      kind: "response",
      stepId: "S1",
      content: JSON.stringify({ method: "POST", url: "x", response: { status: 200, body: FAULT } }),
    };
    const dodged = await checkSoapAttempt(attempt(plain), plan, validator);
    expect(dodged.outcome).toBe("error");
    expect(dodged.error).toBe("S1: the plan's SOAP operation GetPrice was not called with api.soap()");
  });

  it("REQ-EXEC-50/AC1+AC2: a plain XML answer is checked against the XSD; the planner sees the XSD's elements", async () => {
    const xmlCall = (body: string, type = "application/xml; charset=utf-8"): EvidenceItem => ({
      name: "S1-01.json",
      kind: "response",
      stepId: "S1",
      content: JSON.stringify({
        method: "GET",
        url: "http://127.0.0.1:3000/ping",
        response: { status: 200, headers: { "content-type": type }, body },
      }),
    });
    const loose = PlanSchema.parse({
      ...plan,
      cases: [
        {
          ...plan.cases[0],
          steps: [{ id: "S1", action: "GET /ping", expect: { description: "Pong", status: 200 } }],
        },
      ],
    });
    const good = attempt(xmlCall("<Ping>4</Ping>"));
    expect(await checkSoapAttempt(good, loose, validator)).toEqual(good);
    const bad = await checkSoapAttempt(
      attempt(xmlCall("<Ping>four</Ping>", "application/atom+xml")),
      loose,
      validator,
    );
    expect(bad.outcome).toBe("failed");
    expect(String(bad.assertions.at(-1)?.actual)).toContain("'four' is not a valid value");
    const notXml = attempt(xmlCall("<Ping>four</Ping>", "text/html"));
    expect(await checkSoapAttempt(notXml, loose, validator)).toEqual(notXml);
    expect(await checkSoapAttempt(attempt(xmlCall("<Ping>four</Ping>")), loose, undefined)).toEqual(
      attempt(xmlCall("<Ping>four</Ping>")),
    );
    expect(xsdElements(XSD)).toEqual(["Ping"]);
    expect(
      xsdElements(
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n  <xs:element/>\n  <xs:element name="B"/>\n</xs:schema>',
      ),
    ).toEqual(["B"]);
    expect(() => xsdElements("<a/>")).toThrow(/XSD/);
  });

  it("REQ-EXEC-50: an envelope without a body, a step or case outside the plan and a call without its request are read safely", async () => {
    const bare = await checkSoapAttempt(
      attempt(exchange("S1", '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"/>')),
      plan,
      validator,
    );
    expect(bare.assertions.at(-1)?.actual).toBe("the answer is not XML, or its body is empty");
    const spaced = attempt(exchange("S1", ANSWER.replace("<soap:Body>", "<soap:Body>\n  ")));
    expect(await checkSoapAttempt(spaced, plan, validator)).toEqual(spaced);
    const outside = attempt(exchange("S9", FAULT));
    expect((await checkSoapAttempt(outside, plan, undefined)).assertions.at(-1)?.field).toBe("soap.fault");
    const otherCase = { ...attempt(exchange("S1", ANSWER)), caseId: "TC-99" };
    expect(await checkSoapAttempt(otherCase, plan, validator)).toEqual(otherCase);
    const noRequest: EvidenceItem = {
      name: "S1-01.json",
      kind: "response",
      stepId: "S1",
      content: JSON.stringify({ soap: { version: "1.1" }, response: { status: 200 } }),
    };
    const unsent = await checkSoapAttempt(attempt(noRequest), plan, validator);
    expect(unsent.error).toBe("S1: the plan's operation is GetPrice, the request sends nothing");
  });

  it("REQ-EXEC-50: calls that are not SOAP, unreadable evidence and a bad contract are handled", async () => {
    const rest: EvidenceItem = {
      name: "S1-01.json",
      kind: "response",
      stepId: "S1",
      content: JSON.stringify({ method: "GET", url: "x", response: { status: 200, body: "<a/>" } }),
    };
    const broken: EvidenceItem = { name: "S1-02.json", kind: "response", stepId: "S1", content: "{" };
    const bytes: EvidenceItem = {
      name: "S1-03.json",
      kind: "response",
      stepId: "S1",
      content: new Uint8Array([1]),
    };
    const json = exchange("S1", { not: "xml" });
    const record = attempt(rest, broken, bytes, exchange("S1", ANSWER));
    expect(await checkSoapAttempt(record, plan, validator)).toEqual(record);
    const answeredJson = await checkSoapAttempt(attempt(json), plan, validator);
    expect(answeredJson.assertions.at(-1)?.actual).toBe("the answer is not XML, or its body is empty");
    expect(await createXmlValidator({})("<anything/>")).toEqual([]);
    expect(() => createXmlValidator({ xsd: ["<notASchema/>"] })).toThrow(/XSD/);
    expect(() => createXmlValidator({ wsdl: "nope" })).toThrow(/WSDL/);
    const errored = { ...attempt(exchange("S1", FAULT)), outcome: "error" as const, error: "timeout" };
    expect((await checkSoapAttempt(errored, plan, undefined)).outcome).toBe("error");
  });
});
