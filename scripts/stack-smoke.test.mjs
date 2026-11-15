import { describe, expect, it } from "vitest";
import { digestProblems, pinnedModels, SMOKE_PROJECT } from "./stack-smoke.mjs";
import { parseProjectConfig } from "@qajitsu/core";
import { parse } from "yaml";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

describe("the stack smoke test's own checks (REQ-GEN-10/AC3+AC4)", () => {
  it("REQ-GEN-10/AC4: reads the pinned models from the stack's models step", () => {
    const compose = {
      services: {
        models: {
          command: [
            "stack",
            "pull",
            "--ollama",
            "http://ollama:11434",
            `qwen3:4b@${A}`,
            `all-minilm:latest@${B}`,
          ],
        },
      },
    };
    expect([...pinnedModels(compose)]).toEqual([
      ["qwen3:4b", A],
      ["all-minilm:latest", B],
    ]);
    expect(pinnedModels({}).size).toBe(0);
  });

  it("REQ-GEN-10/AC4: a model Ollama lacks, or holds at another digest, is a problem; bare hex digests count", () => {
    const pinned = new Map([
      ["qwen3:4b", A],
      ["all-minilm:latest", B],
    ]);
    expect(
      digestProblems(pinned, {
        models: [
          { name: "qwen3:4b", digest: "a".repeat(64) },
          { name: "all-minilm:latest", digest: B },
        ],
      }),
    ).toEqual([]);
    expect(digestProblems(pinned, { models: [{ name: "qwen3:4b", digest: B }] })).toEqual([
      `qwen3:4b is ${B}, the stack pins ${A}`,
      "all-minilm:latest is not in Ollama",
    ]);
    expect(digestProblems(pinned, {})).toHaveLength(2);
  });

  it("REQ-GEN-10/AC3: the project it onboards is a valid configuration with the auditor off", () => {
    const config = parseProjectConfig(parse(SMOKE_PROJECT));
    expect(config.verification.auditor).toBe("off");
  });
});
