import { describe, expect, it } from "vitest";
import { releaseDecision } from "./unpublished-check.mjs";

const packages = [
  { name: "@qajitsu/cli", version: "0.2.0" },
  { name: "@qajitsu/core", version: "0.2.0" },
  { name: "@qajitsu/steps", version: "0.2.0" },
];
const registry = (answers) => (spec) => answers[spec] ?? "absent";
const tagged = (tags) => (tag) => tags.includes(tag);

describe("whether a release run publishes (REQ-GEN-15/AC2, REQ-GEN-09)", () => {
  it("REQ-GEN-15/AC2: nothing of the release in the registry yet: publish", () => {
    expect(releaseDecision(packages, registry({}), tagged([])).action).toBe("publish");
  });

  it("REQ-GEN-15/AC2: everything published and the CLI tagged: the release is done, nothing to publish", () => {
    const all = Object.fromEntries(packages.map((p) => [`${p.name}@${p.version}`, "published"]));
    expect(releaseDecision(packages, registry(all), tagged(["@qajitsu/cli@0.2.0"]))).toEqual({
      action: "done",
      reason: "@qajitsu/cli@0.2.0 is released and tagged; nothing to publish",
    });
  });

  it("REQ-GEN-09: a version someone published before the release run is never skipped silently", () => {
    // One package of the new version already there: publishing the rest would ship a tarball nobody here built.
    const some = releaseDecision(packages, registry({ "@qajitsu/core@0.2.0": "published" }), tagged([]));
    expect(some).toEqual({
      action: "refuse",
      reason: "already in the registry, though the rest of the release is not: @qajitsu/core@0.2.0",
    });
    // All of them there, but no release run tagged them: the same, even though nothing is left to publish.
    const all = Object.fromEntries(packages.map((p) => [`${p.name}@${p.version}`, "published"]));
    expect(releaseDecision(packages, registry(all), tagged(["@qajitsu/cli@0.1.0"])).action).toBe("refuse");
    // A tag of another package does not count: only the CLI's release tag is made by a release run.
    expect(releaseDecision(packages, registry(all), tagged(["@qajitsu/core@0.2.0"])).action).toBe("refuse");
  });

  it("REQ-GEN-15/AC2: a registry that does not answer, or an empty release, never means publish", () => {
    const decision = releaseDecision(packages, registry({ "@qajitsu/steps@0.2.0": "unknown" }), tagged([]));
    expect(decision).toEqual({
      action: "refuse",
      reason: "the registry did not answer for @qajitsu/steps@0.2.0",
    });
    // Unknown wins even over "everything else published and tagged".
    const rest = {
      "@qajitsu/cli@0.2.0": "published",
      "@qajitsu/core@0.2.0": "published",
      "@qajitsu/steps@0.2.0": "error",
    };
    expect(releaseDecision(packages, registry(rest), tagged(["@qajitsu/cli@0.2.0"])).action).toBe("refuse");
    // Only an explicit "absent" counts as not published: any other answer is no answer.
    for (const answer of ["error", "", undefined])
      expect(
        releaseDecision(packages, (spec) => (spec === "@qajitsu/core@0.2.0" ? answer : "absent"), tagged([]))
          .action,
        String(answer),
      ).toBe("refuse");
    expect(releaseDecision([], registry({}), tagged([])).action).toBe("refuse");
  });
});
