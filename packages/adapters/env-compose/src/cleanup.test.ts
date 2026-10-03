import { describe, expect, it } from "vitest";
import type { CommandExec } from "./build.js";
import { removeRunResources } from "./cleanup.js";

describe("label-based cleanup (REQ-WS-03)", () => {
  it("REQ-WS-03/AC3 + AC4: removes only resources labelled with the run and qajitsu.managed", async () => {
    const calls: string[][] = [];
    const exec: CommandExec = (cmd, args) => {
      calls.push([cmd, ...args]);
      const out =
        args[0] === "ps"
          ? "c1\nc2\n"
          : args[0] === "volume" && args[1] === "ls"
            ? "v1\n"
            : args[1] === "ls"
              ? "n1\n"
              : "";
      return Promise.resolve({ stdout: out, stderr: "" });
    };
    expect(await removeRunResources("20261003-1046-aaaa", exec)).toEqual({
      containers: 2,
      volumes: 1,
      networks: 1,
    });
    for (const c of calls.filter((x) => x.includes("--quiet"))) {
      expect(c).toContain("label=qajitsu.run=20261003-1046-aaaa");
      expect(c).toContain("label=qajitsu.managed=true");
    }
    expect(calls).toContainEqual(["docker", "rm", "--force", "--volumes", "c1", "c2"]);
    expect(calls).toContainEqual(["docker", "volume", "rm", "--force", "v1"]);
    expect(calls).toContainEqual(["docker", "network", "rm", "n1"]);
  });

  it("REQ-WS-03/AC4: an invalid run id or missing docker removes nothing", async () => {
    const calls: string[][] = [];
    const exec: CommandExec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return Promise.reject(new Error("docker: not found"));
    };
    expect(await removeRunResources("x --filter label=y", exec)).toEqual({
      containers: 0,
      volumes: 0,
      networks: 0,
    });
    expect(calls).toEqual([]);
    expect(await removeRunResources("20261003-1046-aaaa", exec)).toEqual({
      containers: 0,
      volumes: 0,
      networks: 0,
    });
  });
});
