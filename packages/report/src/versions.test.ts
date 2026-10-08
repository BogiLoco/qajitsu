import { describe, expect, it } from "vitest";
import { renderJiraWiki } from "./jira-comment.js";
import { diffVersions, formatVersions } from "./versions.js";

describe("tool versions in reports (REQ-OBS-10)", () => {
  it("REQ-OBS-10/AC2: one line, the basics first; nothing recorded says so", () => {
    expect(
      formatVersions({
        "model planner": "a/b",
        chromium: "153.0",
        node: "v22.12.0",
        qajitsu: "0.4.0",
        zz: "1",
      }),
    ).toBe("qajitsu 0.4.0 · node v22.12.0 · chromium 153.0 · model planner a/b · zz 1");
    expect(formatVersions(undefined)).toBe("not recorded");
    expect(formatVersions({})).toBe("not recorded");
  });

  it("REQ-OBS-10/AC3: lists what differs among the tools both runs recorded", () => {
    expect(
      diffVersions(
        { qajitsu: "0.4.0", chromium: "150.0", node: "v22.12.0", appium: "2.0.0" },
        { qajitsu: "0.4.0", chromium: "153.0", node: "v22.14.0", docker: "27.0.0" },
      ),
    ).toEqual(["node v22.12.0 → v22.14.0", "chromium 150.0 → 153.0"]);
    expect(diffVersions({ node: "v1" }, { node: "v1" })).toEqual([]);
    expect(diffVersions(undefined, { node: "v1" })).toEqual([]);
  });

  it("REQ-OBS-10/AC2: the ticket comment names the tools of the run", () => {
    const wiki = renderJiraWiki({
      ticket: "SHOP-1",
      runId: "r1",
      date: "2026-10-08",
      environment: { name: "staging", baseUrl: "https://staging.example" },
      repos: {},
      versions: { qajitsu: "0.4.0", chromium: "153.0" },
      planVersion: 1,
      planSha256: "a".repeat(64),
      executor: "qa-lead",
      rows: [],
      summary: "0 cases",
      failures: [],
      reproduce: "qj evidence SHOP-1",
      attachments: [],
      notes: [],
    });
    expect(wiki).toContain("Tools: qajitsu 0.4.0 · chromium 153.0");
  });
});
