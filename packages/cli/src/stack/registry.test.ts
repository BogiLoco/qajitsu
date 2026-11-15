import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, textReply } from "../../../../tests/support/fake-fetch.js";
import { parsePinnedImage, parsePinnedModel, resolveQajitsuImage } from "./registry.js";

const INDEX = `sha256:${"c".repeat(64)}`;

describe("digests of what the stack runs (REQ-GEN-10/AC4)", () => {
  it("REQ-GEN-10/AC4: resolves ghcr.io/bogiloco/qajitsu:<version> to the digest of its image index", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/token\?scope=repository%3Abogiloco%2Fqajitsu%3Apull/,
        reply: jsonReply({ token: "anon" }),
      },
      {
        method: "HEAD",
        match: /^\/v2\/bogiloco\/qajitsu\/manifests\/0\.1\.0$/,
        reply: () => new Response(null, { status: 200, headers: { "docker-content-digest": INDEX } }),
      },
    ]);
    expect(await resolveQajitsuImage("0.1.0", fake.fetch)).toEqual({
      repository: "ghcr.io/bogiloco/qajitsu",
      version: "0.1.0",
      digest: INDEX,
    });
    const head = fake.requests.find((r) => r.method === "HEAD");
    expect(head?.headers["authorization"]).toBe("Bearer anon");
    expect(head?.headers["accept"]).toContain("application/vnd.oci.image.index.v1+json");
  });

  it("REQ-GEN-10/AC4: a version that is not published stops with a message naming --image", async () => {
    const fake = createFakeFetch([
      { match: /^\/token/, reply: jsonReply({ token: "anon" }) },
      { method: "HEAD", match: /^\/v2\//, reply: textReply("", 404) },
    ]);
    await expect(resolveQajitsuImage("0.2.0", fake.fetch)).rejects.toThrow(
      /ghcr\.io\/bogiloco\/qajitsu:0\.2\.0 is not published.*--image/,
    );
    // An answer without a digest, or with something else, is no digest either.
    const odd = createFakeFetch([
      { match: /^\/token/, reply: jsonReply({ token: "anon" }) },
      {
        method: "HEAD",
        match: /^\/v2\//,
        reply: () =>
          new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:short" } }),
      },
    ]);
    await expect(resolveQajitsuImage("0.1.0", odd.fetch)).rejects.toThrow(/--image/);
  });

  it("REQ-GEN-10/AC4: an image given by hand must carry its digest; a tag alone is refused", () => {
    expect(parsePinnedImage(`localhost:5000/qajitsu:dev@${INDEX}`)).toEqual({
      repository: "localhost:5000/qajitsu",
      version: "dev",
      digest: INDEX,
    });
    expect(parsePinnedImage(`ghcr.io/bogiloco/qajitsu@${INDEX}`)).toEqual({
      repository: "ghcr.io/bogiloco/qajitsu",
      version: "unknown",
      digest: INDEX,
    });
    for (const bad of [
      "ghcr.io/bogiloco/qajitsu:0.1.0",
      "qajitsu",
      `qajitsu@sha256:abc`,
      `bad image@${INDEX}`,
    ])
      expect(() => parsePinnedImage(bad), bad).toThrow(/digest/);
  });

  it("REQ-GEN-10/AC4: a model given by hand as name@digest is taken as pinned; anything else is refused", () => {
    expect(parsePinnedModel(`qwen3:4b@${INDEX}`)).toEqual({ name: "qwen3:4b", digest: INDEX });
    expect(parsePinnedModel(`nomic-embed-text@${INDEX}`)).toEqual({
      name: "nomic-embed-text:latest",
      digest: INDEX,
    });
    expect(parsePinnedModel("qwen3:4b")).toBeUndefined();
    for (const bad of [`qwen3:4b@sha256:abc`, `Bad Name@${INDEX}`, `../x@${INDEX}`])
      expect(() => parsePinnedModel(bad), bad).toThrow();
  });
});
