import { describe, expect, it } from "vitest";
import { ContextFragmentSchema, ContextSnapshotSchema, fragment, snapshotHash } from "./fragments.js";

describe("context fragments and snapshots (REQ-CTX-11, REQ-CTX-17)", () => {
  it("REQ-CTX-11/AC1: a fragment carries kind, source, trust, layout, priority, pin, tokens and hash", () => {
    const f = fragment({
      kind: "ticket",
      source: "DEMO-1",
      trust: "untrusted",
      section: "varying",
      priority: 80,
      pinned: false,
      text: "The cart total is rounded once.",
    });
    expect(ContextFragmentSchema.parse(f)).toEqual(f);
    expect(f.tokens).toBe(8);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => ContextFragmentSchema.parse({ ...f, kind: "secret" })).toThrow();
  });

  it("REQ-CTX-17/AC3: the snapshot hash depends on content and order, not on key order", () => {
    const base = {
      schema: 1 as const,
      stage: "audit",
      role: "auditor",
      model: "mock/m",
      renderer: "neutral-1",
      marker: "a1b2c3d4e5f6",
      fragments: [],
      reductions: [],
      tokensByKind: { plan: 10 },
    };
    const reordered = {
      tokensByKind: { plan: 10 },
      reductions: [],
      fragments: [],
      marker: "a1b2c3d4e5f6",
      renderer: "neutral-1",
      model: "mock/m",
      role: "auditor",
      stage: "audit",
      schema: 1 as const,
    };
    expect(snapshotHash(base)).toBe(snapshotHash(reordered));
    expect(snapshotHash({ ...base, marker: "ffffffffffff" })).not.toBe(snapshotHash(base));
    expect(ContextSnapshotSchema.parse({ ...base, sha256: snapshotHash(base) }).sha256).toBe(
      snapshotHash(base),
    );
  });
});
