---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/cli": minor
---

SOAP and XML APIs (REQ-EXEC-50).

- **Contract:** `repos.<alias>.wsdl` and `repos.<alias>.xsd` name the WSDL and XML Schemas of the analysed commit.
- **Planning:** the planner sees the WSDL's operations and the XSDs' elements. A plan step names
  `soap: { operation: "GetPrice" }` and expects XPaths under `xml`; a draft citing an operation the WSDL lacks goes
  back to the planner.
- **Specs:** `api.soap(path, body, { action, version })` sends SOAP 1.1 or 1.2, and `res.xml(xpath)` reads an XPath.
  `verify(step, "xml.<xpath>", ...)` reads the value from the response itself.
- **Checks after each attempt:**
  - an unplanned fault fails the step, even with HTTP 200;
  - an answer outside the WSDL or XSD fails it too;
  - a request without the planned operation, or a SOAP step that skips `api.soap()`, makes the case BLOCKED.
- `checkAttempt` of the API runner may be async.

New dependencies:

- `@xmldom/xmldom` (MIT): an XML parser in pure JavaScript, no native code;
- `xpath` (MIT): XPath 1.0 over that DOM, loaded untyped so its DOM types stay out of the build;
- `xmllint-wasm` (MIT): libxml2's XSD validation compiled to WebAssembly, no native build or postinstall.

All are pinned in the lockfile.
