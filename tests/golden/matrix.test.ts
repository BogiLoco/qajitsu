// Golden output: the Markdown matrix that becomes the Jira comment body (REQ-EVD-04, REQ-PUB-01).
// Update deliberately with `pnpm test -u` and explain the change in the PR.
import { renderMatrixMarkdown, type MatrixRow } from "@qajitsu/report";
import { expect, it } from "vitest";

const rows: MatrixRow[] = [
  {
    caseId: "TC-01",
    title: "Adding a product returns 201 and recalculates the total",
    requirement: "AC-1",
    type: "api",
    status: "PASSED",
    stepsPassed: 1,
    stepsTotal: 1,
    evidence: "req/resp × 1",
  },
  {
    caseId: "TC-02",
    title: "Cart shows the new total in the UI",
    requirement: "AC-1",
    type: "web",
    status: "FAILED",
    stepsPassed: 1,
    stepsTotal: 2,
    evidence: "2 screenshots, video, trace",
  },
  {
    caseId: "TC-03",
    title: "Quantity limit of 99 per item",
    requirement: "AC-2",
    type: "api",
    status: "PASSED",
    stepsPassed: 2,
    stepsTotal: 2,
    evidence: "req/resp × 2",
  },
  {
    caseId: "TC-04",
    title: "Add to cart in the Android app",
    requirement: "AC-3",
    type: "mobile",
    status: "BLOCKED",
    stepsPassed: 0,
    stepsTotal: 3,
    evidence: "emulator log",
  },
];

it("renders the matrix exactly as the golden file", async () => {
  await expect(renderMatrixMarkdown(rows)).toMatchFileSnapshot("./matrix.golden.md");
});
