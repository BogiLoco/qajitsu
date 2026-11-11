import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXPECTED, integrityHex, provenanceProblems, purl } from "./provenance-check.mjs";

const pkg = { name: "@qajitsu/core", version: "0.2.0" };
const tarball = Buffer.from("the published tarball");
const hex = createHash("sha512").update(tarball).digest("hex");
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

/** The registry's attestations for a provenance statement, with parts overridden. */
function attestations(over = {}) {
  const statement = {
    subject: [{ name: "pkg:npm/%40qajitsu/core@0.2.0", digest: { sha512: hex } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: EXPECTED.repository, path: EXPECTED.path, ref: EXPECTED.ref },
        },
        internalParameters: { github: { event_name: "push" } },
      },
      runDetails: { metadata: { invocationId: `${EXPECTED.repository}/actions/runs/4242/attempts/1` } },
    },
    ...over,
  };
  return {
    attestations: [
      { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } },
      },
    ],
  };
}
const withPredicate = (patch) => {
  const base = JSON.parse(
    Buffer.from(attestations().attestations[1].bundle.dsseEnvelope.payload, "base64").toString("utf8"),
  );
  return attestations({ predicate: patch(base.predicate) });
};

describe("provenance of what was published (REQ-GEN-15/AC2, REQ-GEN-09)", () => {
  it("REQ-GEN-15/AC2: a package built by this run of the Release workflow on main, for its tarball, passes", () => {
    expect(provenanceProblems(pkg, attestations(), integrity, "4242")).toEqual([]);
    expect(purl("@qajitsu/cli", "1.0.0")).toBe("pkg:npm/%40qajitsu/cli@1.0.0");
    expect(integrityHex(integrity)).toBe(hex);
    expect(integrityHex("sha1-abc")).toBeUndefined();
    // A truncated SHA-512 is no SHA-512: it could never be compared with the subject digest.
    expect(integrityHex(`sha512-${Buffer.from("short").toString("base64")}`)).toBeUndefined();
    expect(integrityHex(undefined)).toBeUndefined();
  });

  it("REQ-GEN-09: a version someone published between the check and the publish is refused", () => {
    // Published by another run, even of the same workflow: e.g. a stale decision raced by a leaked token.
    expect(provenanceProblems(pkg, attestations(), integrity, "4243")).toEqual([
      `@qajitsu/core@0.2.0 was published by ${EXPECTED.repository}/actions/runs/4242/attempts/1, not by run 4243`,
    ]);
    // A prefix of the run id is not the run.
    expect(provenanceProblems(pkg, attestations(), integrity, "424")).toHaveLength(1);
    // No provenance at all: published with a token from a laptop.
    expect(provenanceProblems(pkg, { attestations: [] }, integrity, "4242")).toEqual([
      "@qajitsu/core@0.2.0 has 0 SLSA provenance attestations, not one",
    ]);
    expect(provenanceProblems(pkg, undefined, integrity, "4242")).toHaveLength(1);
  });

  it("REQ-GEN-09: provenance from another repository, workflow, branch or event is refused", () => {
    const cases = [
      ["repository", "https://github.com/someone/qajitsu"],
      ["path", ".github/workflows/ci.yml"],
      ["ref", "refs/heads/feature"],
    ];
    for (const [key, value] of cases) {
      const a = withPredicate((p) => {
        p.buildDefinition.externalParameters.workflow[key] = value;
        return p;
      });
      expect(provenanceProblems(pkg, a, integrity, "4242"), key).toEqual([
        `@qajitsu/core@0.2.0 was built by ${key} ${value}, not ${EXPECTED[key]}`,
      ]);
    }
    const pr = withPredicate((p) => {
      p.buildDefinition.internalParameters.github.event_name = "pull_request_target";
      return p;
    });
    expect(provenanceProblems(pkg, pr, integrity, "4242")).toEqual([
      "@qajitsu/core@0.2.0 was built for a pull_request_target event, not push",
    ]);
  });

  it("REQ-GEN-09: a provenance about another tarball or package is refused", () => {
    const other = `sha512-${createHash("sha512").update("another tarball").digest("base64")}`;
    expect(provenanceProblems(pkg, attestations(), other, "4242")).toEqual([
      "@qajitsu/core@0.2.0: the provenance is not about the tarball the registry serves",
    ]);
    const renamed = attestations({
      subject: [{ name: "pkg:npm/%40qajitsu/steps@0.2.0", digest: { sha512: hex } }],
    });
    expect(provenanceProblems(pkg, renamed, integrity, "4242")).toHaveLength(1);
    const two = attestations({
      subject: [
        { name: "pkg:npm/%40qajitsu/core@0.2.0", digest: { sha512: hex } },
        { name: "pkg:npm/%40qajitsu/core@0.2.0", digest: { sha512: hex } },
      ],
    });
    expect(provenanceProblems(pkg, two, integrity, "4242")).toHaveLength(1);
    expect(provenanceProblems(pkg, attestations(), undefined, "4242")).toEqual([
      "@qajitsu/core@0.2.0 has no SHA-512 integrity in the registry",
    ]);
  });

  it("REQ-GEN-09: unreadable or doubled provenance is refused, never skipped", () => {
    const broken = {
      attestations: [
        { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: "%%%" } } },
      ],
    };
    expect(provenanceProblems(pkg, broken, integrity, "4242")).not.toEqual([]);
    const doubled = { attestations: [...attestations().attestations, attestations().attestations[1]] };
    expect(provenanceProblems(pkg, doubled, integrity, "4242")).toEqual([
      "@qajitsu/core@0.2.0 has 2 SLSA provenance attestations, not one",
    ]);
  });
});
