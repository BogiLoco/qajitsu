import type { EvidenceEntry, ExploreSession } from "@qajitsu/core";
import { ExploreSessionSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { renderExploreHtml, renderExploreMarkdown } from "./explore.js";

const session: ExploreSession = ExploreSessionSchema.parse({
  schema: 1,
  id: "S01",
  ticket: "DEMO-4",
  run: "20261005-1000-aaaa",
  goal: "Check checkout around the terms change",
  environment: { name: "local", baseUrl: "http://127.0.0.1:3000" },
  model: "local/gemma",
  startedAt: "2026-10-05T10:00:00Z",
  endedAt: "2026-10-05T10:04:00Z",
  endReason: "step-budget",
  budget: { minutes: 10, steps: 3 },
  summary: "Checkout stays disabled.",
  actions: [
    {
      id: "A01",
      action: "goto",
      target: "/app/checkout",
      ok: true,
      url: "http://127.0.0.1:3000/app/checkout",
      screenshot: "A01.png",
      at: "t1",
    },
    {
      id: "A02",
      action: "click",
      target: "testid:terms",
      ok: true,
      url: "http://127.0.0.1:3000/app/checkout",
      screenshot: "A02.png",
      at: "t2",
    },
    {
      id: "A03",
      action: "click",
      target: "testid:place-order",
      ok: false,
      error: "element is disabled",
      url: "http://127.0.0.1:3000/app/checkout",
      screenshot: "A03.png",
      at: "t3",
    },
  ],
  observations: [
    {
      id: "O1",
      title: "Place order stays disabled <script>alert(1)</script>",
      kind: "possible-bug",
      severity: "high",
      description: "After accepting the terms the button is still disabled.",
      steps: ["A01", "A02", "A03"],
      expected: "Button enabled",
      actual: "Button disabled",
    },
  ],
  recordings: ["recordings/video.webm", "recordings/network.har"],
});
const manifest: EvidenceEntry[] = [
  "A01.png",
  "A02.png",
  "A03.png",
  "recordings/video.webm",
  "recordings/network.har",
].map((path, i) => ({ path, caseId: "explore", kind: "screenshot", sha256: String(i).repeat(64), bytes: 1 }));

describe("exploratory session report (REQ-EXEC-15/AC6)", () => {
  it("REQ-EXEC-15/AC6 + REQ-EXEC-15/AC3: Markdown lists the goal, why it ended, observations with steps, screenshots by hash and no statuses", () => {
    const md = renderExploreMarkdown(session, manifest);
    expect(md).toContain("# Exploratory session S01 for DEMO-4");
    expect(md).toContain("ended because the step budget was used (enforced by QAJitsu)");
    expect(md).toContain("### O1 · Place order stays disabled");
    expect(md).toContain(
      "3. A03 click testid:place-order → http://127.0.0.1:3000/app/checkout · [A03.png](evidence/A03.png) `222222222222`",
    );
    expect(md).toContain("| A03 | click testid:place-order | error: element is disabled |");
    expect(md).toContain("[recordings/video.webm](evidence/recordings/video.webm)");
    expect(md).not.toMatch(/\b(PASSED|FAILED|BLOCKED|NEEDS_REVIEW)\b/);
  });

  it("REQ-EXEC-15/AC6: the HTML page shows step screenshots, the timeline and the video; agent text is escaped", () => {
    const html = renderExploreHtml(session, manifest);
    expect(html).toContain('<img src="evidence/A02.png" alt="A02 after the action"');
    expect(html).toContain('<video src="evidence/recordings/video.webm" controls');
    expect(html).toContain('<tr id="A03" class="bad">');
    expect(html).toContain(
      "qajitsu explore promote DEMO-4 --run 20261005-1000-aaaa --session S01 --observation O1",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/\b(PASSED|FAILED|BLOCKED|NEEDS_REVIEW)\b/);
  });
});
