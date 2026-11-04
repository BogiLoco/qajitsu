import { readFile } from "node:fs/promises";
import { createXmlValidator, wsdlOperations, xsdElements, type XmlValidator } from "@qajitsu/verifier";
import type { RunSession } from "./session.js";

/**
 * The SOAP and XML contract of the analysed commit (REQ-EXEC-50/AC1+AC2): the WSDL and XSD files a repository names
 * under `wsdl` and `xsd`, read from the run's worktree. Undefined when no repository names one.
 *
 * @param session - The run.
 * @throws {ConfigError} `WSDL_INVALID` or `XSD_INVALID` when a file is not what its name says.
 */
export async function soapContractOf(session: Pick<RunSession, "project" | "ws">): Promise<
  | {
      readonly validator: XmlValidator;
      readonly operations: readonly string[];
      readonly elements: readonly string[];
      readonly source: string;
    }
  | undefined
> {
  for (const [alias, repo] of Object.entries(session.project.config.repos)) {
    const xsdFiles = repo.xsd ?? [];
    if ((repo.wsdl === undefined && xsdFiles.length === 0) || session.ws.record.repos[alias] === undefined)
      continue;
    const read = (file: string) => readFile(session.ws.path("repos", alias, file), "utf8");
    const wsdl = repo.wsdl === undefined ? undefined : await read(repo.wsdl);
    const xsd = await Promise.all(xsdFiles.map(read));
    return {
      validator: createXmlValidator({ ...(wsdl === undefined ? {} : { wsdl }), xsd }),
      operations: wsdl === undefined ? [] : wsdlOperations(wsdl),
      elements: xsd.flatMap(xsdElements),
      source: [repo.wsdl, ...xsdFiles]
        .filter((f) => f !== undefined)
        .map((f) => `${alias}/${f}`)
        .join(", "),
    };
  }
  return undefined;
}
