import { describe, expect, it } from "vitest";
import { holdUntil } from "./hold.js";

const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("waiting for Ctrl+C keeps the process alive (REQ-GEN-05/AC2)", () => {
  it("REQ-GEN-05/AC2: a pending wait holds a timer, so Node does not exit when only signal listeners are left", async () => {
    let release: () => void = () => undefined;
    const stopped = new Promise<string>((resolve) => {
      release = () => {
        resolve("stopped");
      };
    });
    const before = timers();
    const held = holdUntil(stopped);
    expect(timers()).toBe(before + 1);
    release();
    expect(await held).toBe("stopped");
    expect(timers()).toBe(before);
  });

  it("REQ-GEN-05/AC2: the timer is released when the wait fails too", async () => {
    const before = timers();
    await expect(holdUntil(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(timers()).toBe(before);
  });
});
