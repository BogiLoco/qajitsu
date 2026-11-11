import { describe, expect, it } from "vitest";
import { releaseDecision } from "./unpublished-check.mjs";

const packages = [
  { name: "@qajitsu/cli", version: "0.2.0" },
  { name: "@qajitsu/core", version: "0.2.0" },
  { name: "@qajitsu/steps", version: "0.2.0" },
];
const registry = (answers) => (spec) => answers[spec] ?? "absent";
const tagged = (tags) => (tag) => tags.includes(tag);
const all = Object.fromEntries(packages.map((p) => [`${p.name}@${p.version}`, "published"]));
/** What the earlier run's provenance says, per package name. */
const earlierFrom = (byName) => (pkg) => byName[pkg.name] ?? { problems: [`${pkg.name} not expected here`] };

describe("whether a release run publishes (REQ-GEN-15/AC2, REQ-GEN-09)", () => {
  it("REQ-GEN-15/AC2: nothing of the release in the registry yet: publish", async () => {
    expect(await releaseDecision(packages, registry({}), tagged([]))).toEqual({
      action: "publish",
      reason: "3 packages, none of them in the registry yet",
    });
  });

  it("REQ-GEN-15/AC2: everything published and the CLI tagged: the release is done, nothing to publish", async () => {
    expect(await releaseDecision(packages, registry(all), tagged(["@qajitsu/cli@0.2.0"]))).toEqual({
      action: "done",
      reason: "@qajitsu/cli@0.2.0 is released and tagged; nothing to publish",
    });
  });

  it("REQ-GEN-15/AC2: a release the registry stopped half-way is finished, naming the run that published its start", async () => {
    // e.g. npm's limit on new packages (E429) after the first packages of a first release.
    const decision = await releaseDecision(
      packages,
      registry({ "@qajitsu/core@0.2.0": "published", "@qajitsu/steps@0.2.0": "published" }),
      tagged([]),
      earlierFrom({
        "@qajitsu/core": { run: "4242", problems: [] },
        "@qajitsu/steps": { run: "4242", problems: [] },
      }),
    );
    expect(decision).toEqual({
      action: "publish",
      reason: "finishing a release: 2 of 3 packages were published by run 4242",
      earlierRuns: ["4242"],
    });
    // Two interrupted attempts: both runs are named, so the provenance check accepts both.
    const twice = await releaseDecision(
      packages,
      registry({ "@qajitsu/core@0.2.0": "published", "@qajitsu/steps@0.2.0": "published" }),
      tagged([]),
      earlierFrom({
        "@qajitsu/core": { run: "4242", problems: [] },
        "@qajitsu/steps": { run: "4250", problems: [] },
      }),
    );
    expect(twice.earlierRuns).toEqual(["4242", "4250"]);
  });

  it("REQ-GEN-09: a version someone published outside the Release workflow is never skipped silently", async () => {
    const some = registry({ "@qajitsu/core@0.2.0": "published" });
    // Without a way to check what is there, part of a release in the registry is refused.
    expect(await releaseDecision(packages, some, tagged([]))).toEqual({
      action: "refuse",
      reason: "already in the registry, though the rest of the release is not: @qajitsu/core@0.2.0",
    });
    // Published with a leaked token: no provenance of the Release workflow, so nothing is published after it.
    const foreign = await releaseDecision(
      packages,
      some,
      tagged([]),
      earlierFrom({
        "@qajitsu/core": { problems: ["@qajitsu/core@0.2.0 has 0 SLSA provenance attestations, not one"] },
      }),
    );
    expect(foreign).toEqual({
      action: "refuse",
      reason:
        "part of the release is in the registry without the Release workflow's provenance: @qajitsu/core@0.2.0 has 0 SLSA provenance attestations, not one",
    });
    expect(foreign.earlierRuns).toBeUndefined();
    // One good, one bad: still refused; a run is never taken from a provenance that has problems.
    const mixed = await releaseDecision(
      packages,
      registry({ "@qajitsu/core@0.2.0": "published", "@qajitsu/steps@0.2.0": "published" }),
      tagged([]),
      earlierFrom({
        "@qajitsu/core": { run: "4242", problems: [] },
        "@qajitsu/steps": { run: "9999", problems: ["@qajitsu/steps@0.2.0 was built by ref refs/heads/x"] },
      }),
    );
    expect(mixed.action).toBe("refuse");
    // All of them there, but no release run tagged them: refused, even though nothing is left to publish.
    expect((await releaseDecision(packages, registry(all), tagged(["@qajitsu/cli@0.1.0"]))).action).toBe(
      "refuse",
    );
    // A tag of another package does not count: only the CLI's release tag is made by a release run.
    expect((await releaseDecision(packages, registry(all), tagged(["@qajitsu/core@0.2.0"]))).action).toBe(
      "refuse",
    );
  });

  it("REQ-GEN-15/AC2: a registry that does not answer, or an empty release, never means publish", async () => {
    expect(
      await releaseDecision(packages, registry({ "@qajitsu/steps@0.2.0": "unknown" }), tagged([])),
    ).toEqual({
      action: "refuse",
      reason: "the registry did not answer for @qajitsu/steps@0.2.0",
    });
    // Unknown wins even over "everything else published and tagged".
    const rest = {
      "@qajitsu/cli@0.2.0": "published",
      "@qajitsu/core@0.2.0": "published",
      "@qajitsu/steps@0.2.0": "error",
    };
    expect((await releaseDecision(packages, registry(rest), tagged(["@qajitsu/cli@0.2.0"]))).action).toBe(
      "refuse",
    );
    // Only an explicit "absent" counts as not published: any other answer is no answer.
    for (const answer of ["error", "", undefined])
      expect(
        (
          await releaseDecision(
            packages,
            (spec) => (spec === "@qajitsu/core@0.2.0" ? answer : "absent"),
            tagged([]),
          )
        ).action,
        String(answer),
      ).toBe("refuse");
    expect((await releaseDecision([], registry({}), tagged([]))).action).toBe("refuse");
    // A provenance lookup that throws does not turn into "publish" either.
    await expect(
      releaseDecision(packages, registry({ "@qajitsu/core@0.2.0": "published" }), tagged([]), () => {
        throw new Error("the registry answered 503");
      }),
    ).rejects.toThrow("503");
  });
});
