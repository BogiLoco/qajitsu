import { describe, expect, it } from "vitest";
import { nodeVersionWarning } from "./check-node.mjs";

describe("Node.js version of verify (REQ-NFR-10/AC3)", () => {
  it("REQ-NFR-10/AC3: another major than .nvmrc is named with how to switch; the same major says nothing", () => {
    expect(nodeVersionWarning("v26.0.0", "22\n")).toBe(
      "Warning: Node.js v26.0.0 runs this check, CI uses Node.js 22 (.nvmrc). Failures that only Node.js 22 shows stay hidden here; switch with 'nvm use' or 'fnm use' before relying on a green verify.\n",
    );
    expect(nodeVersionWarning("v22.23.4", "22\n")).toBeUndefined();
    expect(nodeVersionWarning("v22.23.4", "v22.12.0")).toBeUndefined();
    expect(nodeVersionWarning("v22.23.4", "")).toBeUndefined();
  });
});
