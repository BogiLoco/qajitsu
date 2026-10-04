import type { TicketKey } from "../identifiers.js";

/** A change linked to a ticket: pull request (GitHub), merge request (GitLab), branch or commit (REQ-CTX-03). */
export interface ChangeRef {
  /** Code host alias from `.qa/qa.project.yaml`. */
  readonly host: string;
  /** Repository path on the host, e.g. `example-org/shop-web`. */
  readonly repo: string;
  readonly kind: "pr" | "mr" | "branch" | "sha";
  /** PR number, MR iid, branch name or SHA. */
  readonly id: string;
  readonly title?: string;
  /** PR/MR description, used as analysis context (REQ-CTX-05/AC3). */
  readonly description?: string;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly headSha: string;
  readonly url?: string;
  /** Why discovery found this change; set by `findChangesForTicket`. */
  readonly matchedBy?: "title" | "branch";
}

/** A reference to a change before it is resolved to a SHA. */
export interface ChangeLocator {
  readonly repo: string;
  readonly kind: "pr" | "mr" | "branch" | "sha";
  /** PR number, MR iid, or any branch, tag or SHA for `branch`/`sha`. */
  readonly id: string;
}

/** A review comment on a PR/MR, used as analysis context (REQ-CTX-05). */
export interface ReviewComment {
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
}

/** Access to a code host: GitHub and GitLab, cloud and self-hosted (REQ-CTX-02). */
/** A pull or merge request to comment on (REQ-CI-04/AC4). */
export interface ChangeTarget {
  readonly repo: string;
  readonly kind: "pr" | "mr";
  /** PR number or MR iid. */
  readonly id: string;
}

/** A commit status check shown on the PR/MR (REQ-CI-04/AC4). */
export interface CommitStatus {
  readonly state: "pending" | "success" | "failure" | "error";
  /** Check name, e.g. `qajitsu/DEMO-1`. */
  readonly context: string;
  readonly description: string;
  readonly targetUrl?: string | undefined;
}

export interface CodeHost {
  /** Host type, e.g. `github`. */
  readonly type: string;
  /** Finds PRs/MRs and branches whose title or branch name contains the ticket key (REQ-CTX-03/AC2). */
  findChangesForTicket(
    key: TicketKey,
    repos: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ChangeRef[]>;
  /** Parses a PR/MR, branch or commit URL of this host; `undefined` when the URL belongs elsewhere. */
  parseChangeUrl(url: string): ChangeLocator | undefined;
  /** Resolves a PR/MR, branch, tag or SHA to a change with its exact head SHA (REQ-CTX-03/AC3, REQ-CTX-04). */
  resolveChange(locator: ChangeLocator, signal?: AbortSignal): Promise<ChangeRef>;
  /** Unified diff of the change against its target branch (REQ-CTX-05). */
  getDiff(change: ChangeRef, signal?: AbortSignal): Promise<string>;
  getReviewComments(change: ChangeRef, signal?: AbortSignal): Promise<readonly ReviewComment[]>;
  /** Authenticated clone URL; never logged (REQ-CFG-06). */
  cloneUrl(repo: string): Promise<string>;
  /**
   * Creates or updates the QAJitsu comment on a PR/MR: the comment containing `marker` is edited, so
   * re-runs do not pile up comments (REQ-CI-03/AC1, REQ-CI-04/AC4).
   */
  upsertComment?(
    target: ChangeTarget,
    body: string,
    marker: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url?: string | undefined }>;
  /** Sets a commit status check on `sha` (REQ-CI-04/AC4). */
  setCommitStatus?(repo: string, sha: string, status: CommitStatus, signal?: AbortSignal): Promise<void>;
  /** Cheap access check for `qajitsu doctor --online` (REQ-GEN-03/AC2); never returns secrets. */
  check?(signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** Downloads a CI artifact, e.g. an APK for a commit (REQ-ENV-06). */
  downloadArtifact?(repo: string, sha: string, name: string, signal?: AbortSignal): Promise<Uint8Array>;
}
