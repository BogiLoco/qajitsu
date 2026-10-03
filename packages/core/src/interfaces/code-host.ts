import type { TicketKey } from "../identifiers.js";

/** A change linked to a ticket: pull request (GitHub), merge request (GitLab), branch or commit (REQ-CTX-03). */
export interface ChangeRef {
  readonly host: string;
  readonly repo: string;
  readonly kind: "pr" | "mr" | "branch" | "sha";
  readonly id: string;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly headSha: string;
  readonly url?: string;
}

/** A review comment on a PR/MR, used as analysis context (REQ-CTX-05). */
export interface ReviewComment {
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
}

/** Access to a code host: GitHub and GitLab, cloud and self-hosted (REQ-CTX-02). */
export interface CodeHost {
  /** Finds PRs/MRs and branches whose title or branch name contains the ticket key (REQ-CTX-03). */
  findChangesForTicket(
    key: TicketKey,
    repos: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ChangeRef[]>;
  /** Unified diff of the change against its target branch (REQ-CTX-05). */
  getDiff(change: ChangeRef, signal?: AbortSignal): Promise<string>;
  getReviewComments(change: ChangeRef, signal?: AbortSignal): Promise<readonly ReviewComment[]>;
  /** Authenticated clone URL; never logged (REQ-CFG-06). */
  cloneUrl(repo: string): Promise<string>;
  /** Downloads a CI artifact, e.g. an APK for a commit (REQ-ENV-06). */
  downloadArtifact?(repo: string, sha: string, name: string, signal?: AbortSignal): Promise<Uint8Array>;
}
