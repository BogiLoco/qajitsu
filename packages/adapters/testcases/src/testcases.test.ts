import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketKeySchema, xlsxRows } from "@qajitsu/core";
import { zip } from "@qajitsu/report";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, testDeps } from "../../../../tests/support/fake-fetch.js";
import {
  createFileCaseSource,
  createTestRailCaseSource,
  createXrayCaseSource,
  createZephyrCaseSource,
  parseCsv,
} from "./index.js";

const ticket = TicketKeySchema.parse("SHOP-482");
const secrets = {
  "secret://env/XRAY_ID": "xray-client-id-1",
  "secret://env/XRAY_SECRET": "xray-client-secret-1",
  "secret://env/ZEPHYR": "zephyr-token-123",
  "secret://env/TESTRAIL": "testrail-key-123",
};

describe("Xray Cloud test cases (REQ-CTX-08/AC1)", () => {
  it("REQ-CTX-08/AC1: authenticates, queries tests linked to the ticket and maps steps, Gherkin and preconditions", async () => {
    const fake = createFakeFetch([
      { method: "POST", match: /^\/api\/v2\/authenticate$/, reply: jsonReply('"xray-token-abc"') },
      {
        method: "POST",
        match: /^\/api\/v2\/graphql$/,
        reply: jsonReply({
          data: {
            getTests: {
              total: 3,
              results: [
                {
                  jira: { key: "SHOP-101", summary: "Discount applied" },
                  steps: [{ action: "Add code SAVE10", data: "SAVE10", result: "Total -10%" }],
                  preconditions: { results: [{ definition: "Cart has items" }] },
                },
                { jira: { key: "SHOP-102", summary: "Gherkin" }, steps: [], gherkin: "Given a cart" },
                { jira: { key: "SHOP-103", summary: "Generic" }, steps: null, unstructured: "Check it" },
              ],
            },
          },
        }),
      },
    ]);
    const deps = testDeps(fake.fetch, secrets);
    const source = createXrayCaseSource(
      {
        baseUrl: "https://xray.example.com",
        clientId: "secret://env/XRAY_ID",
        clientSecret: "secret://env/XRAY_SECRET",
      },
      deps,
    );
    const cases = await source.findCases(ticket);
    expect(cases.map((c) => c.id)).toEqual(["xray:SHOP-101", "xray:SHOP-102", "xray:SHOP-103"]);
    expect(cases[0]).toEqual({
      id: "xray:SHOP-101",
      system: "xray",
      title: "Discount applied",
      preconditions: "Cart has items",
      steps: [{ action: "Add code SAVE10", data: "SAVE10", expected: "Total -10%" }],
    });
    expect(cases[1]?.steps).toEqual([{ action: "Given a cart" }]);
    expect(cases[2]?.steps).toEqual([{ action: "Check it" }]);
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      client_id: "xray-client-id-1",
      client_secret: "xray-client-secret-1",
    });
    const query = JSON.parse(fake.requests[1]?.body ?? "{}") as { variables: { jql: string } };
    expect(query.variables.jql).toBe('issue in linkedIssues("SHOP-482") AND issuetype = Test');
    expect(fake.requests[1]?.headers["authorization"]).toBe("Bearer xray-token-abc");
    expect(deps.registered).toContain("xray-token-abc");
  });

  it("REQ-CTX-08/AC4: GraphQL errors and missing data are adapter errors", async () => {
    const make = (body: unknown) =>
      createXrayCaseSource(
        {
          baseUrl: "https://xray.example.com",
          clientId: "secret://env/XRAY_ID",
          clientSecret: "secret://env/XRAY_SECRET",
          jql: "key = {ticket}",
        },
        testDeps(
          createFakeFetch([
            { method: "POST", match: /authenticate/, reply: jsonReply('"t"') },
            { method: "POST", match: /graphql/, reply: jsonReply(body) },
          ]).fetch,
          secrets,
        ),
      );
    await expect(make({ errors: [{ message: "bad jql" }] }).findCases(ticket)).rejects.toMatchObject({
      code: "XRAY_GRAPHQL",
    });
    await expect(make({ data: {} }).findCases(ticket)).rejects.toMatchObject({ code: "XRAY_MALFORMED" });
  });
});

describe("Zephyr Scale test cases (REQ-CTX-08/AC1)", () => {
  it("REQ-CTX-08/AC1: reads the cases linked to the ticket with inline steps, HTML as text", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/v2\/issuelinks\/SHOP-482\/testcases$/,
        reply: jsonReply([{ key: "SHOP-T1" }, { key: "../x" }]),
      },
      {
        match: /^\/v2\/testcases\/SHOP-T1$/,
        reply: jsonReply({
          key: "SHOP-T1",
          name: "Code stacking",
          objective: "<p>No stacking</p>",
          precondition: null,
        }),
      },
      {
        match: /^\/v2\/testcases\/SHOP-T1\/teststeps\?maxResults=100$/,
        reply: jsonReply({
          values: [
            {
              inline: {
                description: "<b>Apply</b> two codes",
                testData: "A, B",
                expectedResult: "Only B applies",
              },
            },
            { testCase: { key: "SHOP-T9" } },
          ],
        }),
      },
    ]);
    const source = createZephyrCaseSource(
      { baseUrl: "https://zephyr.example.com/v2", token: "secret://env/ZEPHYR" },
      testDeps(fake.fetch, secrets),
    );
    const cases = await source.findCases(ticket);
    expect(cases).toEqual([
      {
        id: "zephyr:SHOP-T1",
        system: "zephyr",
        title: "Code stacking",
        preconditions: "No stacking",
        steps: [{ action: "Apply two codes", data: "A, B", expected: "Only B applies" }],
      },
    ]);
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer zephyr-token-123");
  });
});

describe("TestRail test cases (REQ-CTX-08/AC1)", () => {
  it("REQ-CTX-08/AC1: filters by references exactly, follows pages and maps separated and text steps", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/index\.php\?\/api\/v2\/get_cases\/3&suite_id=7&refs=SHOP-482$/,
        reply: jsonReply({
          cases: [
            {
              id: 11,
              title: "Rounding",
              refs: "SHOP-482, SHOP-1",
              custom_preconds: "Two lines",
              custom_steps_separated: [
                { content: "Open cart", expected: "Total 10.05", additional_info: "user:standard" },
              ],
            },
            { id: 12, title: "Other ticket", refs: "SHOP-4821" },
          ],
          _links: { next: "/api/v2/get_cases/3&suite_id=7&refs=SHOP-482&offset=250" },
        }),
      },
      {
        match: /offset=250/,
        reply: jsonReply({
          cases: [
            {
              id: 13,
              title: "Text steps",
              refs: "SHOP-482",
              custom_steps: "Do it",
              custom_expected: "Works",
            },
          ],
          _links: { next: null },
        }),
      },
    ]);
    const source = createTestRailCaseSource(
      {
        baseUrl: "https://tr.example.com",
        user: "qa@example.com",
        token: "secret://env/TESTRAIL",
        projectId: 3,
        suiteId: 7,
      },
      testDeps(fake.fetch, secrets),
    );
    const cases = await source.findCases(ticket);
    expect(cases.map((c) => c.id)).toEqual(["testrail:C11", "testrail:C13"]);
    expect(cases[0]).toMatchObject({
      preconditions: "Two lines",
      steps: [{ action: "Open cart", data: "user:standard", expected: "Total 10.05" }],
      url: "https://tr.example.com/index.php?/cases/view/11",
    });
    expect(cases[1]?.steps).toEqual([{ action: "Do it", expected: "Works" }]);
    expect(fake.requests[0]?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("qa@example.com:testrail-key-123").toString("base64")}`,
    );
  });

  it("REQ-CTX-08/AC1: an older TestRail answers a plain array", async () => {
    const fake = createFakeFetch([
      {
        match: /get_cases\/3&refs=SHOP-482$/,
        reply: jsonReply([{ id: 5, title: "Plain", refs: "SHOP-482" }]),
      },
    ]);
    const source = createTestRailCaseSource(
      {
        baseUrl: "https://tr.example.com/",
        user: "secret://env/TESTRAIL",
        token: "secret://env/TESTRAIL",
        projectId: 3,
      },
      testDeps(fake.fetch, secrets),
    );
    expect((await source.findCases(ticket)).map((c) => c.id)).toEqual(["testrail:C5"]);
  });

  it("REQ-CTX-08/AC4: an unreachable TestRail is an adapter error", async () => {
    const source = createTestRailCaseSource(
      { baseUrl: "https://tr.example.com", user: "u", token: "secret://env/TESTRAIL", projectId: 3 },
      testDeps(() => Promise.reject(new Error("ECONNREFUSED")), secrets),
    );
    await expect(source.findCases(ticket)).rejects.toMatchObject({ code: "TESTRAIL_UNREACHABLE" });
  });
});

describe("CSV and Excel test cases (REQ-CTX-08/AC1)", () => {
  const dir = () => mkdtemp(join(tmpdir(), "qj-cases-"));

  it("parses quoted, semicolon-separated CSV with CRLF line ends", () => {
    expect(parseCsv('﻿id;title\r\n1;"a; ""b"""\r\n\r\n2;"multi\nline"')).toEqual([
      ["id", "title"],
      ["1", 'a; "b"'],
      ["2", "multi\nline"],
    ]);
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("REQ-CTX-08/AC1: rows of the ticket form cases by id; other tickets and invalid ids are skipped", async () => {
    const d = await dir();
    const file = join(d, "cases.csv");
    await writeFile(
      file,
      [
        "ID,Ticket,Title,Preconditions,Step,Test data,Expected result",
        'M-1,"SHOP-482, SHOP-1",Rounding,Two lines,Open cart,,Total 10.05',
        "M-1,SHOP-482,,,Apply code,SAVE10,Total 9.05",
        "M-2,SHOP-9,Other,,x,,y",
        "bad id,SHOP-482,Broken,,x,,y",
      ].join("\n"),
    );
    const cases = await createFileCaseSource(file).findCases(ticket);
    expect(cases).toEqual([
      {
        id: "file:M-1",
        system: "file",
        title: "Rounding",
        preconditions: "Two lines",
        steps: [
          { action: "Open cart", expected: "Total 10.05" },
          { action: "Apply code", data: "SAVE10", expected: "Total 9.05" },
        ],
      },
    ]);
  });

  it("REQ-CTX-08/AC1: reads an Excel workbook with shared and inline strings", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const bytes = zip([
      {
        name: "xl/sharedStrings.xml",
        data: enc(
          "<sst><si><t>id</t></si><si><t>ticket</t></si><si><r><t>ti</t></r><r><t>tle</t></r></si><si><t>SHOP-482</t></si></sst>",
        ),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: enc(
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>expected</t></is></c></row>' +
            '<row r="2"><c r="A2" t="inlineStr"><is><t>X-1</t></is></c><c r="B2" t="s"><v>3</v></c><c r="C2" t="str"><v>Fish &amp; chips</v></c><c r="D2"><v>42</v></c></row></sheetData></worksheet>',
        ),
      },
    ]);
    const d = await dir();
    await writeFile(join(d, "cases.xlsx"), bytes);
    expect(xlsxRows(Buffer.from(bytes))?.[1]).toEqual(["X-1", "SHOP-482", "Fish & chips", "42"]);
    expect(await createFileCaseSource(join(d, "cases.xlsx")).findCases(ticket)).toEqual([
      { id: "file:X-1", system: "file", title: "Fish & chips", steps: [{ action: "", expected: "42" }] },
    ]);
    expect(xlsxRows(Buffer.from("not a zip"))).toBeUndefined();
  });

  it("REQ-CTX-08/AC4: a missing file, an unreadable workbook or missing columns are adapter errors", async () => {
    const d = await dir();
    await expect(createFileCaseSource(join(d, "none.csv")).findCases(ticket)).rejects.toMatchObject({
      code: "TESTCASES_FILE_UNREADABLE",
    });
    await writeFile(join(d, "bad.xlsx"), "nope");
    await expect(createFileCaseSource(join(d, "bad.xlsx")).findCases(ticket)).rejects.toMatchObject({
      code: "TESTCASES_FILE_UNREADABLE",
    });
    await writeFile(join(d, "cols.csv"), "name,step\nx,y\n");
    await expect(createFileCaseSource(join(d, "cols.csv")).findCases(ticket)).rejects.toMatchObject({
      code: "TESTCASES_FILE_COLUMNS",
    });
  });
});
