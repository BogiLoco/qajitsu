import { describe, expect, it } from "vitest";
import { changelogSection, pushAuth, releaseFor } from "./github-release.mjs";
import { tagEvents } from "./release-tags.mjs";

describe("tags and the GitHub release (REQ-GEN-15/AC2)", () => {
  it("REQ-GEN-15/AC2: the new tags are read from changesets' output events, nothing else", () => {
    const text = [
      JSON.stringify({ type: "git-tag", tag: "@qajitsu/core@0.2.0", packageName: "@qajitsu/core" }),
      "",
      "not json",
      JSON.stringify({ type: "publish", tag: "x" }),
      JSON.stringify({ type: "git-tag", tag: 5, packageName: "@qajitsu/cli" }),
      JSON.stringify({ type: "git-tag", tag: "@qajitsu/cli@0.2.0", packageName: "@qajitsu/cli" }),
    ].join("\n");
    expect(tagEvents(text)).toEqual([
      { tag: "@qajitsu/core@0.2.0", packageName: "@qajitsu/core" },
      { tag: "@qajitsu/cli@0.2.0", packageName: "@qajitsu/cli" },
    ]);
    expect(tagEvents("")).toEqual([]);
  });

  it("REQ-GEN-15/AC2: the release notes are the CLI's changelog for the version and every package with it", () => {
    const changelog =
      "# @qajitsu/cli\n\n## 0.2.0\n\n### Minor Changes\n\n- New thing\n\n## 0.1.0\n\n- Old thing\n";
    expect(changelogSection(changelog, "0.2.0")).toBe("### Minor Changes\n\n- New thing");
    expect(changelogSection(changelog, "0.1.0")).toBe("- Old thing");
    expect(changelogSection(changelog, "9.9.9")).toBe("");
    const release = releaseFor(
      [
        { tag: "@qajitsu/core@0.2.0", packageName: "@qajitsu/core" },
        { tag: "@qajitsu/cli@0.2.0", packageName: "@qajitsu/cli" },
      ],
      (v) => changelogSection(changelog, v),
    );
    expect(release?.tag).toBe("@qajitsu/cli@0.2.0");
    expect(release?.title).toBe("QAJitsu 0.2.0");
    expect(release?.notes).toContain("- New thing");
    expect(release?.notes).not.toContain("Old thing");
    expect(release?.notes).toContain("- `@qajitsu/cli@0.2.0`\n- `@qajitsu/core@0.2.0`");
    // Without a changelog entry the notes still list the packages.
    expect(
      releaseFor([{ tag: "@qajitsu/cli@1.0.0", packageName: "@qajitsu/cli" }], () => "")?.notes,
    ).toContain("See the changelogs of the packages.");
    // A run that did not publish the CLI makes no release.
    expect(
      releaseFor([{ tag: "@qajitsu/core@0.2.1", packageName: "@qajitsu/core" }], () => "x"),
    ).toBeUndefined();
  });

  it("REQ-GEN-15/AC2: tags are pushed with the workflow's token from the environment, never from the command line", () => {
    const auth = pushAuth({ GH_TOKEN: "tok-123", GITHUB_ACTIONS: "true" });
    expect(auth).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok-123").toString("base64")}`,
    });
    // Outside the workflow, or without a token, git uses what it has.
    expect(pushAuth({ GH_TOKEN: "tok-123" })).toEqual({});
    expect(pushAuth({ GITHUB_ACTIONS: "true" })).toEqual({});
  });
});
