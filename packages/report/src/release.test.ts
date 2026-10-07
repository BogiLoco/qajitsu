import { describe, expect, it } from "vitest";
import {
  renderReleaseAdf,
  renderReleaseMarkdown,
  renderReleaseWiki,
  summarizeRelease,
  ticketReadiness,
  type ReleaseModel,
  type ReleaseTicketRow,
} from "./release.js";

const row = (over: Partial<ReleaseTicketRow> & { key: string }): ReleaseTicketRow => ({
  summary: `Story ${over.key}`,
  ticketStatus: "Done",
  runId: "20261007-1000-abcd",
  counts: { PASSED: 2 },
  open: [],
  gatesOk: true,
  ...over,
});

const model = (tickets: ReleaseTicketRow[]): ReleaseModel => ({
  name: "2.4",
  by: "fixVersion",
  date: "2026-10-07",
  tickets,
});

describe("release report (REQ-PUB-09)", () => {
  it("REQ-PUB-09/AC3: only a trusted run with every case PASSED is ready; no run is never ready", () => {
    expect(ticketReadiness(row({ key: "A-1" }))).toBe("ready");
    expect(ticketReadiness(row({ key: "A-1", runId: undefined, counts: {} }))).toBe("no run");
    expect(ticketReadiness(row({ key: "A-1", gatesOk: false }))).toBe("untrusted");
    expect(ticketReadiness(row({ key: "A-1", problem: "unreadable" }))).toBe("untrusted");
    expect(ticketReadiness(row({ key: "A-1", counts: { PASSED: 1, NEEDS_REVIEW: 1 } }))).toBe("not ready");
    expect(ticketReadiness(row({ key: "A-1", counts: {} }))).toBe("not ready");
  });

  it("REQ-PUB-09/AC3: release counts come from the rows; an empty release is not ready", () => {
    const s = summarizeRelease(
      model([
        row({ key: "A-1" }),
        row({ key: "A-2", counts: { PASSED: 1, FAILED: 1 } }),
        row({ key: "A-3", runId: undefined, counts: { PASSED: 9 } }),
        row({ key: "A-4", gatesOk: false }),
      ]),
    );
    expect(s).toEqual({
      tickets: 4,
      ready: 1,
      notReady: 1,
      noRun: 1,
      untrusted: 1,
      cases: { PASSED: 5, FAILED: 1 },
      releaseReady: false,
    });
    expect(summarizeRelease(model([])).releaseReady).toBe(false);
    expect(summarizeRelease(model([row({ key: "A-1" })])).releaseReady).toBe(true);
  });

  it("REQ-PUB-09/AC2: markdown lists counts, open FAILED and NEEDS_REVIEW cases and tickets without a run", () => {
    const md = renderReleaseMarkdown(
      model([
        row({
          key: "A-2",
          summary: "Cart | totals",
          counts: { PASSED: 1, FAILED: 1, NEEDS_REVIEW: 1 },
          open: [
            { caseId: "TC-02", title: "Rounding", status: "FAILED" },
            { caseId: "TC-03", title: "Layout", status: "NEEDS_REVIEW" },
          ],
        }),
        row({ key: "A-3", runId: undefined, counts: {} }),
        row({ key: "A-4", gatesOk: false, problem: "publish gates failed: plan-hash" }),
      ]),
    );
    expect(md).toContain("# Release readiness: fix version 2.4");
    expect(md).toContain("NOT READY: 0 of 3 ticket(s) ready, 1 not ready, 1 untrusted, 1 without a run.");
    expect(md).toContain(
      "| A-2 | Cart \\| totals | Done | not ready | 20261007-1000-abcd | 1 PASSED, 1 FAILED, 1 NEEDS_REVIEW |",
    );
    expect(md).toContain("| A-3 | Story A-3 | Done | no run | – | – |");
    expect(md).toContain("- A-2 TC-02 FAILED: Rounding");
    expect(md).toContain("- A-2 TC-03 NEEDS_REVIEW: Layout");
    expect(md).toContain("- A-3: no executed run; not tested.");
    expect(md).toContain("- A-4 run 20261007-1000-abcd: publish gates failed: plan-hash.");
    expect(renderReleaseMarkdown(model([]))).toContain("(no tickets found)");
  });

  it("REQ-PUB-09/AC4: wiki and ADF carry the same computed lines", () => {
    const m = {
      ...model([row({ key: "A-1" }), row({ key: "A-5", runId: undefined, counts: {} })]),
      by: "sprint" as const,
    };
    const wiki = renderReleaseWiki(m);
    expect(wiki).toContain("h3. Release readiness: sprint 2.4");
    expect(wiki).toContain("||Ticket||Summary||Ticket status||Readiness||Run||Cases||");
    expect(wiki).toContain("* A\\-5: no executed run; not tested.");
    const adf = JSON.stringify(renderReleaseAdf(m));
    expect(adf).toContain("NOT READY: 1 of 2 ticket(s) ready, 1 without a run.");
    expect(adf).toContain("Without trustworthy results");
    expect(adf).not.toContain("Open cases");
    const ready = renderReleaseAdf(
      model([row({ key: "A-1", open: [{ caseId: "TC-1", title: "", status: "FLAKY" }] })]),
    );
    expect(JSON.stringify(ready)).toContain("Open cases");
    expect(
      renderReleaseWiki(
        model([row({ key: "A-1", open: [{ caseId: "TC-1", title: "x", status: "FLAKY" }] })]),
      ),
    ).toContain("h4. Open cases");
  });
});
