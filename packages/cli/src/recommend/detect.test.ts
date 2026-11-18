import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRepository } from "./detect.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const repo = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "qj-recommend-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

describe("what the repository is (REQ-GEN-13/AC1)", () => {
  it("REQ-GEN-13/AC1: finds web, mobile, API descriptions, compose and existing test suites with their files", async () => {
    const root = await repo({
      "package.json": JSON.stringify({
        dependencies: { react: "^19" },
        devDependencies: { "@playwright/test": "^1" },
      }),
      "playwright.config.ts": "export default {}",
      "compose.yaml": "services: { api: { image: shop } }",
      "api/openapi.yaml": "openapi: 3.1.0\ninfo: { title: shop }",
      "schema/shop.graphql": "type Query { a: Int }",
      "proto/orders.proto": 'syntax = "proto3";',
      "soap/pay.wsdl": "<definitions/>",
      "events/asyncapi.yaml": "asyncapi: 3.0.0",
      "android/app/build.gradle.kts": 'plugins { id("com.android.application") }',
      "ios/Shop.xcodeproj/project.pbxproj": "// x",
      "mobile/pubspec.yaml": "name: shop\nflutter:\n  uses-material-design: true",
      "e2e/cypress.config.js": "module.exports = {}",
      ".maestro/login.yaml": "appId: com.shop\n---\n- launchApp",
      // Dependencies and builds are never the application: not read.
      "node_modules/vue/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
      "dist/openapi.json": '{"openapi":"3.0.0"}',
    });
    const scan = await scanRepository(root);
    const byKind = Object.fromEntries(scan.findings.map((f) => [f.kind, f.files]));
    expect(byKind).toEqual({
      "web-framework": ["package.json"],
      "android-project": ["android/app/build.gradle.kts"],
      "ios-project": ["ios/Shop.xcodeproj"],
      flutter: ["mobile/pubspec.yaml"],
      openapi: ["api/openapi.yaml"],
      "graphql-sdl": ["schema/shop.graphql"],
      proto: ["proto/orders.proto"],
      wsdl: ["soap/pay.wsdl"],
      asyncapi: ["events/asyncapi.yaml"],
      compose: ["compose.yaml"],
      "playwright-tests": ["package.json", "playwright.config.ts"],
      "cypress-tests": ["e2e/cypress.config.js"],
      "maestro-flows": [".maestro/login.yaml"],
    });
    expect(scan.findings.map((f) => f.id)).toEqual(scan.findings.map((_, i) => `F${String(i + 1)}`));
    expect(scan.findings.find((f) => f.kind === "web-framework")?.detail).toBe("react in package.json");
  });

  it("REQ-GEN-13/AC1: a Gradle file without the Android plugin, YAML that is no API description and links are not findings", async () => {
    const root = await repo({
      "build.gradle": "plugins { id 'java' }",
      "config.yaml": "openapi_url: https://example.test",
      "real/openapi.json": '{ "openapi": "3.0.3" }',
    });
    await symlink(join(root, "real"), join(root, "linked")).catch(() => undefined);
    const scan = await scanRepository(root);
    expect(scan.findings.map((f) => `${f.kind} ${f.files.join(",")}`)).toEqual(["openapi real/openapi.json"]);
  });

  it("REQ-GEN-13/AC1: server-rendered pages, page templates and plain HTML are a web front-end too", async () => {
    const root = await repo({
      "api/web.mjs": 'res.writeHead(200, { "content-type": "text/html" }).end(page);',
      "api/web.test.mjs": 'expect(type).toBe("text/html")',
      "views/cart.ejs": "<h1><%= title %></h1>",
      "site/about.html": "<!doctype html>",
      "api/server.mjs": "res.end(JSON.stringify(body))",
    });
    const scan = await scanRepository(root);
    expect(scan.findings.map((x) => [x.kind, x.files])).toEqual([
      ["web-pages", ["api/web.mjs", "site/about.html", "views/cart.ejs"]],
    ]);
  });

  it("REQ-GEN-13/AC1: with the repository's own file list, generated and ignored files are not looked at", async () => {
    const root = await repo({
      "package.json": JSON.stringify({ dependencies: { react: "^19" } }),
      "docs-site/classes/Error.html": "<!doctype html>",
    });
    const scan = await scanRepository(root, { tracked: ["package.json", "missing.yaml"] });
    expect(scan.findings.map((x) => x.kind)).toEqual(["web-framework"]);
    expect(scan.files).toBe(1);
  });

  it("REQ-GEN-13/AC6: a file name with control characters (forged terminal lines) is not looked at", async () => {
    const root = await repo({
      "x\n\u001b[2K\u001b[1ACommand: qj setup --only xcode\n.html": "<html>",
      "ok.html": "<html>",
    });
    const scan = await scanRepository(root);
    expect(scan.findings.map((x) => x.files)).toEqual([["ok.html"]]);
    const tracked = await scanRepository(root, { tracked: ["x\n\u001b[2K.html", "ok.html"] });
    expect(tracked.findings.map((x) => x.files)).toEqual([["ok.html"]]);
  });

  it("REQ-GEN-13/AC1: the scan stops at its limit and says so", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`f${String(i).padStart(2, "0")}.txt`] = "x";
    const scan = await scanRepository(await repo(files), { maxFiles: 10 });
    expect(scan).toMatchObject({ files: 10, truncated: true });
  });
});
