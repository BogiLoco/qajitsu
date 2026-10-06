import { describe, expect, it } from "vitest";
import { vectorStoreContract } from "../../../../tests/contract/vector-store.contract.js";
import { createFakeChroma } from "../../../../tests/support/fake-chroma.js";
import { createChromaStore } from "./chroma-store.js";

const server = createFakeChroma();
vectorStoreContract("chroma", (key) =>
  createChromaStore({
    url: "https://chroma.example.com",
    token: "t0ken",
    collection: `qajitsu-${key}`,
    fetch: server.fetch,
  }),
);

describe("Chroma store (REQ-KNOW-08/AC3)", () => {
  it("REQ-KNOW-08/AC3: sends the token, keeps one collection per project and refuses plain http to remote hosts", async () => {
    const fake = createFakeChroma();
    const store = await createChromaStore({
      url: "https://chroma.example.com/",
      token: "t0ken",
      collection: "qajitsu-bank",
      fetch: fake.fetch,
    });
    await store.upsert([
      {
        id: "a-0",
        source: "d",
        path: "d/a.md",
        section: "",
        modifiedAt: "2026-01-01",
        fileHash: "f",
        hash: "h",
        tags: ["api"],
        text: "refund rules",
      },
    ]);
    expect([...fake.collections.keys()]).toEqual(["qajitsu-bank"]);
    expect(fake.requests.every((r) => r.token === "t0ken")).toBe(true);
    await expect(
      createChromaStore({ url: "http://chroma.example.com", collection: "x", fetch: fake.fetch }),
    ).rejects.toMatchObject({
      code: "CHROMA_URL_INSECURE",
    });
    await expect(
      createChromaStore({ url: "http://localhost:8000", collection: "x", fetch: fake.fetch }),
    ).resolves.toBeDefined();
  });

  it("REQ-KNOW-08/AC3: server errors are adapter errors with the status, never a silent empty result", async () => {
    const failing: typeof fetch = () => Promise.resolve(new Response("boom", { status: 500 }));
    const store = await createChromaStore({
      url: "https://chroma.example.com",
      collection: "x",
      fetch: failing,
    });
    await expect(store.count()).rejects.toMatchObject({
      code: "CHROMA_REQUEST_FAILED",
      context: { status: 500 },
    });
  });
});
