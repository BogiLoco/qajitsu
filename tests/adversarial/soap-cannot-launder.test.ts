// Adversarial suite: specs that try to make a SOAP fault or a wrong XML answer look like a result (REQ-EXEC-50,
// invariants 1 and 4). The value of an XPath comes from the response, never from the spec; a fault is a failure
// unless the plan expects one; a SOAP step that dodges api.soap() is BLOCKED.
import { PlanSchema } from "@qajitsu/core";
import { createCaseRuntime, createMasker, type AttemptRecord, type CaseRuntime } from "@qajitsu/steps";
import { checkSoapAttempt, computeStatus, createXmlValidator } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-19",
  version: 1,
  summary: "Prices over SOAP.",
  cases: [
    {
      id: "TC-01",
      title: "The mug's price is read",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "POST /soap/prices",
          soap: { operation: "GetPrice" },
          expect: { description: "Priced", status: 200, xml: { "//GetPriceResponse/amount": 24.99 } },
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
const FAULT = envelope(
  "<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Price below the minimum</faultstring></soap:Fault>",
);
const XSD = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:p" elementFormDefault="qualified">
  <xs:element name="GetPriceResponse"><xs:complexType><xs:sequence><xs:element name="amount" type="xs:decimal"/></xs:sequence>
  <xs:attribute name="currency" type="xs:string" use="required"/></xs:complexType></xs:element></xs:schema>`;

const runtimeAnswering = (text: string, status = 200): CaseRuntime =>
  createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.resolve({ status, headers: { "content-type": "text/xml" }, text }),
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
  });

const finish = async (runtime: CaseRuntime, body: () => Promise<void>): Promise<AttemptRecord> => {
  try {
    await runtime.context.step("S1", body);
    return await runtime.finish();
  } catch (error) {
    return await runtime.finish(error);
  }
};

const statusOf = async (record: AttemptRecord, validator?: ReturnType<typeof createXmlValidator>) =>
  computeStatus(
    { caseId: "TC-01", attempts: [await checkSoapAttempt(record, plan, validator)] },
    { evidenceComplete: true },
  );

describe("a SOAP answer never becomes a result it is not (REQ-EXEC-50, invariants 1 and 4)", () => {
  it("REQ-EXEC-50/AC3: a spec that claims the planned amount is checked against the answer's own XPath value", async () => {
    const runtime = runtimeAnswering(
      envelope('<GetPriceResponse currency="EUR"><amount>19.99</amount></GetPriceResponse>'),
    );
    const record = await finish(runtime, async () => {
      await runtime.context.api.soap("/soap/prices", "<GetPrice/>");
      runtime.context.verify(
        "S1",
        "xml.//GetPriceResponse/amount",
        24.99,
        runtime.context.plan.expect("TC-01.S1.xml.//GetPriceResponse/amount"),
      );
    });
    expect(record.assertions[0]?.actual).toBe(19.99);
    expect(await statusOf(record)).toBe("FAILED");
  });

  it("REQ-EXEC-50/AC2: a fault with HTTP 200 and an amount the spec fills in itself is FAILED, never PASSED", async () => {
    const runtime = runtimeAnswering(FAULT);
    const record = await finish(runtime, async () => {
      await runtime.context.api.soap("/soap/prices", "<GetPrice/>");
      runtime.context.verify("S1", "status", 200, runtime.context.plan.expect("TC-01.S1.status"));
    });
    // The runtime's own checks pass (the status really is 200); the fault rule is what fails it.
    expect(record.outcome).toBe("passed");
    expect(await statusOf(record)).toBe("FAILED");
  });

  it("REQ-EXEC-50/AC1+AC2: a spec that sends the envelope as plain text to skip the fault check is BLOCKED", async () => {
    const runtime = runtimeAnswering(
      envelope('<GetPriceResponse currency="EUR"><amount>24.99</amount></GetPriceResponse>'),
    );
    const record = await finish(runtime, async () => {
      const res = await runtime.context.api.post(
        "/soap/prices",
        runtime.context.api.text(envelope("<GetPrice/>"), "text/xml"),
      );
      runtime.context.verify("S1", "status", res.status, runtime.context.plan.expect("TC-01.S1.status"));
      runtime.context.verify(
        "S1",
        "xml.//GetPriceResponse/amount",
        await res.xml("//GetPriceResponse/amount"),
        runtime.context.plan.expect("TC-01.S1.xml.//GetPriceResponse/amount"),
      );
    });
    expect(record.outcome).toBe("passed");
    expect(await statusOf(record)).toBe("BLOCKED");
  });

  it("REQ-EXEC-50/AC2: the right amount in an answer outside the schema is FAILED", async () => {
    const runtime = runtimeAnswering(
      envelope('<p:GetPriceResponse xmlns:p="urn:p"><p:amount>24.99</p:amount></p:GetPriceResponse>'),
    );
    const record = await finish(runtime, async () => {
      const res = await runtime.context.api.soap("/soap/prices", "<GetPrice/>");
      runtime.context.verify(
        "S1",
        "xml.//GetPriceResponse/amount",
        await res.xml("//GetPriceResponse/amount"),
        runtime.context.plan.expect("TC-01.S1.xml.//GetPriceResponse/amount"),
      );
    });
    expect(record.outcome).toBe("passed");
    expect(await statusOf(record, createXmlValidator({ xsd: [XSD] }))).toBe("FAILED");
  });
});
