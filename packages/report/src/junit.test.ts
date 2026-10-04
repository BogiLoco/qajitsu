import { describe, expect, it } from "vitest";
import { renderJUnit } from "./junit.js";

describe("JUnit XML (REQ-CI-04/AC2)", () => {
  it("REQ-CI-04/AC2: FAILED is a failure with expected and actual; non-final statuses are skipped; XML is escaped", () => {
    const xml = renderJUnit({ ticket: "DEMO-1", runId: "20261003-1046-aaaa" }, [
      {
        caseId: "TC-01",
        title: 'Total "rounded" <once>',
        type: "api",
        status: "FAILED",
        durationMs: 1234,
        failures: [{ stepId: "S1", field: "fields.total", expected: 1.01, actual: 1.02 }],
        reportPath: "report/report.html",
      },
      { caseId: "TC-02", title: "Codes", type: "api", status: "PASSED", durationMs: 500, failures: [] },
      {
        caseId: "TC-03",
        title: "Login",
        type: "web",
        status: "BLOCKED",
        failures: [],
        error: "environment not healthy & down\u0001",
      },
      { caseId: "TC-04", title: "Retry", type: "web", status: "FLAKY", failures: [] },
    ]);
    expect(xml).toContain('<testsuites name="QAJitsu" tests="4" failures="1" skipped="2" time="1.734">');
    expect(xml).toContain(
      '<testcase classname="DEMO-1.api" name="TC-01 Total &quot;rounded&quot; &lt;once&gt;" time="1.234">',
    );
    expect(xml).toContain('<failure message="S1 fields.total: expected 1.01, actual 1.02" type="FAILED">');
    expect(xml).toContain('<property name="qajitsu.report" value="report/report.html"/>');
    expect(xml).toContain('<skipped message="BLOCKED: environment not healthy &amp; down"/>');
    expect(xml).toContain('<skipped message="FLAKY"/>');
    expect(xml).not.toContain("\u0001");
    const passing = xml.split("<testcase").find((t) => t.includes("TC-02")) ?? "";
    expect(passing).not.toMatch(/<failure|<skipped/);
    expect(
      renderJUnit({ ticket: "X-1", runId: "r" }, [
        { caseId: "TC-09", title: "t", type: "api", status: "FAILED", failures: [], error: "crash" },
      ]),
    ).toContain('<failure message="crash" type="FAILED">crash</failure>');
  });
});
