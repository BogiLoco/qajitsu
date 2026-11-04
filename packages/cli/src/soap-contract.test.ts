import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphqlSchemaOf } from "./graphql-schema.js";
import type { RunSession } from "./session.js";
import { soapContractOf } from "./soap-contract.js";

const WSDL = new URL("../../../examples/demo-shop/api/prices.wsdl", import.meta.url);
const XSD =
  '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Ping" type="xs:int"/></xs:schema>';

let root: string;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sessionWith = async (repo: Record<string, unknown>, files: Record<string, string>, fetched = true) => {
  root = await mkdtemp(join(tmpdir(), "qj-contract-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, "repos", "shop", "api"), { recursive: true });
    await writeFile(join(root, "repos", "shop", name), text);
  }
  return {
    project: {
      config: { repos: { tests: { host: "local", path: "t" }, shop: { host: "local", path: "s", ...repo } } },
    },
    ws: {
      record: { repos: fetched ? { shop: {}, tests: {} } : {} },
      path: (...p: string[]) => join(root, ...p),
    },
  } as unknown as Pick<RunSession, "project" | "ws">;
};

describe("contracts read from the analysed commit (REQ-EXEC-50/AC1+AC2, REQ-EXEC-48/AC1)", () => {
  it("REQ-EXEC-50/AC1+AC2: the WSDL and XSD of the worktree give the operations, the elements and a validator", async () => {
    const { readFile } = await import("node:fs/promises");
    const session = await sessionWith(
      { wsdl: "api/prices.wsdl", xsd: ["api/ping.xsd"] },
      { "api/prices.wsdl": await readFile(WSDL, "utf8"), "api/ping.xsd": XSD },
    );
    const contract = await soapContractOf(session);
    expect(contract?.operations).toEqual(["GetPrice"]);
    expect(contract?.elements).toEqual(["Ping"]);
    expect(contract?.source).toBe("shop/api/prices.wsdl, shop/api/ping.xsd");
    expect(await contract?.validator("<Ping>1</Ping>")).toEqual([]);
    const xsdOnly = await soapContractOf(
      await sessionWith({ xsd: ["api/ping.xsd"] }, { "api/ping.xsd": XSD }),
    );
    expect(xsdOnly?.operations).toEqual([]);
  });

  it("REQ-EXEC-50/AC2: no contract when no repository names one or the repository was not fetched", async () => {
    expect(await soapContractOf(await sessionWith({}, {}))).toBeUndefined();
    expect(await soapContractOf(await sessionWith({ wsdl: "api/prices.wsdl" }, {}, false))).toBeUndefined();
  });

  it("REQ-EXEC-48/AC1: an SDL file is read from the worktree; an endpoint needs an environment", async () => {
    const sdl = await sessionWith(
      { graphql: "api/schema.graphql" },
      { "api/schema.graphql": "type Query { a: Int }" },
    );
    expect((await graphqlSchemaOf(sdl, { fetch: globalThis.fetch }))?.source).toBe("shop/api/schema.graphql");
    const endpoint = await sessionWith({ graphql: "/graphql" }, {});
    expect(await graphqlSchemaOf(endpoint, { fetch: globalThis.fetch })).toBeUndefined();
  });
});
