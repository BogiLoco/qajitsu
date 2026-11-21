import type ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// A TypeScript version that no longer records syntax errors where the check reads them.
vi.mock("typescript", async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof ts }>()).default;
  return {
    default: {
      ...actual,
      createSourceFile: (...args: Parameters<typeof actual.createSourceFile>) => {
        const source = actual.createSourceFile(...args) as { parseDiagnostics?: unknown };
        delete source.parseDiagnostics;
        return source;
      },
    },
  };
});

const { checkPluginCode } = await import("./plugin-code.js");

describe("the plugin code check when TypeScript changes (REQ-GEN-11/AC9)", () => {
  it("REQ-GEN-11/AC9: without TypeScript's syntax errors nothing can be told, so every file is refused", () => {
    expect(checkPluginCode([{ path: "dist/index.js", text: "export const x = 1;\n" }], ["exec"])).toEqual([
      { file: "dist/index.js", line: 1, use: "code that does not parse", needs: "never" },
    ]);
  });
});
