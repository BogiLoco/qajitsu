import { TicketKeySchema, type CodeHost } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

/** What a fixture-backed host serves for the contract suite. */
export interface CodeHostScenario {
  /** Repository path holding the change. */
  readonly repo: string;
  /** URL of the PR/MR for SHOP-482 (title match). */
  readonly changeUrl: string;
  readonly change: { readonly kind: "pr" | "mr"; readonly id: string; readonly headSha: string };
  /** A branch mentioning SHOP-482 without a PR/MR. */
  readonly branchOnly: { readonly id: string; readonly headSha: string };
  /** Token the host authenticates with; must appear only in clone URL credentials. */
  readonly token: string;
  /** Expected clone URL without credentials. */
  readonly cloneUrl: string;
}

/**
 * Shared contract of every CodeHost (REQ-CTX-02/AC2, REQ-CTX-03).
 *
 * @param name - Implementation name.
 * @param create - Builds a fixture-backed host; `unauthorized` makes every request answer 401.
 * @param scenario - What the fixtures contain.
 */
export function codeHostContract(
  name: string,
  create: (options?: { readonly unauthorized?: boolean }) => CodeHost,
  scenario: CodeHostScenario,
): void {
  const key = TicketKeySchema.parse("SHOP-482");

  describe(`CodeHost contract: ${name}`, () => {
    it("REQ-CTX-03/AC2: finds PR/MR by title or branch and branches without one, skipping SHOP-4820", async () => {
      const changes = await create().findChangesForTicket(key, [scenario.repo]);
      const byId = new Map(changes.map((c) => [c.id, c]));
      expect(byId.get(scenario.change.id)).toMatchObject({
        kind: scenario.change.kind,
        headSha: scenario.change.headSha,
        repo: scenario.repo,
        matchedBy: "title",
      });
      expect(byId.get(scenario.branchOnly.id)).toMatchObject({
        kind: "branch",
        headSha: scenario.branchOnly.headSha,
        matchedBy: "branch",
      });
      expect(changes.some((c) => (c.title ?? c.id).includes("SHOP-4820"))).toBe(false);
      for (const c of changes) expect(c.headSha).toMatch(/^[0-9a-f]{40}$/);
    });

    it("REQ-CTX-03/AC3: parses a change URL and resolves it to the exact head SHA", async () => {
      const host = create();
      const locator = host.parseChangeUrl(scenario.changeUrl);
      expect(locator).toEqual({ repo: scenario.repo, kind: scenario.change.kind, id: scenario.change.id });
      const change = await host.resolveChange(locator!);
      expect(change.headSha).toBe(scenario.change.headSha);
      expect(change.targetBranch).toBeTruthy();
      expect(host.parseChangeUrl("https://elsewhere.example.org/a/b/pull/1")).toBeUndefined();
      expect(host.parseChangeUrl("not a url")).toBeUndefined();
    });

    it("REQ-CTX-03/AC3: resolves a branch, tag or SHA reference", async () => {
      const change = await create().resolveChange({
        repo: scenario.repo,
        kind: "branch",
        id: scenario.branchOnly.id,
      });
      expect(change).toMatchObject({ kind: "branch", headSha: scenario.branchOnly.headSha });
    });

    it("REQ-CTX-05: returns the unified diff and review comments of a change", async () => {
      const host = create();
      const change = await host.resolveChange({
        repo: scenario.repo,
        kind: scenario.change.kind,
        id: scenario.change.id,
      });
      expect(await host.getDiff(change)).toContain("diff --git");
      const comments = await host.getReviewComments(change);
      expect(comments.length).toBeGreaterThan(0);
      expect(comments.every((c) => c.author.length > 0)).toBe(true);
    });

    it("REQ-CTX-02/AC3: puts the token only into clone URL credentials", async () => {
      const url = new URL(await create().cloneUrl(scenario.repo));
      expect(url.password).toBe(scenario.token);
      url.username = "";
      url.password = "";
      expect(url.toString()).toBe(scenario.cloneUrl);
    });

    it("REQ-CTX-02: authentication failures are adapter errors", async () => {
      await expect(
        create({ unauthorized: true }).findChangesForTicket(key, [scenario.repo]),
      ).rejects.toMatchObject({
        name: "AdapterError",
        code: expect.stringMatching(/_AUTH$/) as unknown,
      });
    });

    it("rejects repository paths that could escape the API path", async () => {
      await expect(create().findChangesForTicket(key, ["../../admin"])).rejects.toMatchObject({
        name: "AdapterError",
      });
    });
  });
}
