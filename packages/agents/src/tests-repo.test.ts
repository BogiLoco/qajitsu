import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexTestsRepo, renderTestsRepo } from "./tests-repo.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const repo = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "qj-tests-repo-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

const SHOP_TESTS = {
  "tests/cart.spec.ts": `import { test, expect } from "@playwright/test";
import { CartPage } from "../pages/cart.page";
test.describe("Cart", () => {
  test("cart total is rounded once", async ({ page }) => { await new CartPage(page).open(); });
  it('applies a discount code', async () => {});
  test.skip(\`old flow\`, async () => {});
});
`,
  "features/checkout.feature":
    "Feature: Checkout\n  Scenario: Pay with a card\n    Given a cart\n  Scenario Outline: Pay with <method>\n",
  "pages/cart.page.ts": `export class CartPage {
  constructor(private page) {}
  total = () => this.page.getByTestId("cart-total");
  checkout = () => this.page.getByRole("button", { name: "Checkout" });
  pay = () => this.page.getByTestId('pay');
  legacy = () => this.page.locator(".cart > .row");
}
`,
  "README.md": "# Shop tests\n\nUse data-testid selectors. One spec per feature.\n",
  "CONTRIBUTING.md": "Name tests after the behaviour, not the ticket.\n",
  "node_modules/lib/x.spec.ts": 'test("vendored", () => {});\n',
};

describe("tests repository index (REQ-CTX-06)", () => {
  it("REQ-CTX-06/AC2: lists test files and the titles of their tests (JS/TS and Gherkin); vendored code is skipped", async () => {
    const index = await indexTestsRepo(await repo(SHOP_TESTS));
    expect(index.tests).toEqual([
      { file: "features/checkout.feature", titles: ["Pay with a card", "Pay with <method>"] },
      {
        file: "tests/cart.spec.ts",
        titles: ["cart total is rounded once", "applies a discount code", "old flow"],
      },
    ]);
  });

  it("REQ-CTX-06/AC3 + REQ-EXEC-01/AC3: finds page objects with their selectors and the repository's selector strategy", async () => {
    const index = await indexTestsRepo(await repo(SHOP_TESTS));
    expect(index.pageObjects).toEqual([
      {
        file: "pages/cart.page.ts",
        selectors: [
          'getByTestId("cart-total")',
          'getByRole("button", { name: "Checkout" })',
          "getByTestId('pay')",
          'locator(".cart > .row")',
        ],
      },
    ]);
    expect(index.selectorStrategy).toEqual({
      preferred: "getByTestId",
      counts: { testId: 2, role: 1, label: 0, text: 0, css: 1 },
    });
    expect(index.conventions.map((c) => c.file)).toEqual(["README.md", "CONTRIBUTING.md"]);
  });

  it("REQ-CTX-06/AC2: the rendered index is bounded and wrapped as untrusted data", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `tests/t${String(i)}.spec.ts`,
        `test("case ${String(i)} ${"x".repeat(80)}", () => {});\n`,
      ]),
    );
    const text = renderTestsRepo("e2e", await indexTestsRepo(await repo({ ...SHOP_TESTS, ...many })));
    expect(text.length).toBeLessThan(25_000);
    expect(text).toContain('<untrusted_data source="tests-repo.e2e">');
    expect(text).toContain("more test files not listed");
    expect(text).toContain("Preferred selectors: getByTestId");
  });

  it("an empty or missing repository gives an empty index", async () => {
    expect(await indexTestsRepo(join(tmpdir(), "qj-no-such-repo"))).toEqual({
      tests: [],
      pageObjects: [],
      selectorStrategy: { preferred: undefined, counts: { testId: 0, role: 0, label: 0, text: 0, css: 0 } },
      conventions: [],
    });
  });
});
