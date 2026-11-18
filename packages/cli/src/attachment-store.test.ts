import { parseProjectConfig } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { MAX_STORED_BYTES, storableOversized, storedKey } from "./attachment-store.js";

const config = (oversized: unknown) =>
  parseProjectConfig({
    project: "demo",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    publish: { oversized },
  }).publish.oversized;
const s3 = (over: Record<string, unknown> = {}) => ({
  type: "s3",
  endpoint: "https://s3.eu-central-1.amazonaws.com",
  bucket: "qa-files",
  access_key_id: "secret://env/K",
  secret_access_key: "secret://env/S",
  ...over,
});

describe("which oversized files go to object storage (REQ-PUB-02/AC3)", () => {
  it("REQ-PUB-02/AC3: a file over the limit goes; none when the ticket takes no attachments, none over 2 GB", () => {
    expect(storableOversized(20e6, 10e6)).toBe(true);
    expect(storableOversized(5e6, 10e6)).toBe(false);
    // Attachments switched off in Jira: nothing is sent elsewhere instead.
    expect(storableOversized(20e6, 0)).toBe(false);
    expect(storableOversized(MAX_STORED_BYTES + 1, 10e6)).toBe(false);
  });

  it("REQ-PUB-02/AC3: object keys hold the content hash and only safe characters", () => {
    expect(
      storedKey(
        "qajitsu/attachments/",
        "DEMO-1",
        "20261118-1000-abcd",
        "ab".repeat(32),
        "TC 01/video (1).webm",
      ),
    ).toBe("qajitsu/attachments/DEMO-1/20261118-1000-abcd/abababababababab/TC_01_video_(1).webm");
  });

  it("REQ-PUB-02/AC3: the store needs https (plain http only on localhost), a 1 to 168 hour link and a safe prefix", () => {
    expect(config(s3())).toMatchObject({ link_hours: 72, prefix: "qajitsu/attachments/", path_style: false });
    expect(config(s3({ endpoint: "http://127.0.0.1:9000", path_style: true }))?.type).toBe("s3");
    for (const bad of [
      { endpoint: "http://minio.example.test:9000" },
      { link_hours: 169 },
      { link_hours: 0 },
      { prefix: "../up/" },
      { access_key_id: "AKIDPLAINVALUE" },
      { session_token: "secret://env/T" },
    ])
      expect(() => config(s3(bad)), JSON.stringify(bad)).toThrow();
  });
});
