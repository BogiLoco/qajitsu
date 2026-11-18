import { describe, expect, it } from "vitest";
import { presignV4 } from "./sigv4.js";

describe("presigned links (REQ-PUB-02/AC3)", () => {
  it("REQ-PUB-02/AC3: matches the example of AWS's Signature Version 4 documentation", () => {
    // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", example: GET test.txt for 24 hours.
    const url = presignV4(
      new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      "us-east-1",
      new Date("2013-05-24T00:00:00Z"),
      86_400,
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400");
  });
});
