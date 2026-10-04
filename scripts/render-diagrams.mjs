#!/usr/bin/env node
// Renders docs/assets/*.mmd (Mermaid) to PNG next to them, so diagrams show everywhere, also where Mermaid is not
// rendered (VS Code preview, npm). Uses the Chromium installed for Playwright and Mermaid from jsDelivr.
//   node scripts/render-diagrams.mjs
import { readFile, readdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const dir = fileURLToPath(new URL("../docs/assets/", import.meta.url));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const browser = await chromium.launch();
try {
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".mmd"))) {
    const source = await readFile(join(dir, file), "utf8");
    const page = join(tmpdir(), `qj-diagram-${process.pid}.html`);
    await writeFile(
      page,
      `<!doctype html><html><body style="background:#fff;margin:0;padding:16px"><pre class="mermaid">${esc(source)}</pre>
<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, theme: "default", fontFamily: "Helvetica, Arial, sans-serif" });
await mermaid.run(); document.body.dataset.done = "1";</script></body></html>`,
    );
    const tab = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
    await tab.goto(`file://${page}`);
    await tab.waitForSelector("body[data-done]", { timeout: 30_000 });
    const out = join(dir, file.replace(/\.mmd$/, ".png"));
    await tab.locator("pre.mermaid svg").screenshot({ path: out, omitBackground: false });
    await tab.close();
    await rm(page, { force: true });
    process.stdout.write(`${out}\n`);
  }
} finally {
  await browser.close();
}
