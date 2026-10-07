/** An open bug that may already describe a failure (REQ-PUB-07/AC1). */
export interface BugMatch {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly url?: string | undefined;
}

/** What to look for: open bugs of the project, optionally of components, with any of the words in the summary. */
export interface BugSearch {
  readonly project: string;
  readonly components: readonly string[];
  readonly words: readonly string[];
}

/** A bug to create, rendered by code from the run (REQ-PUB-07/AC2+AC3). */
export interface BugDraft {
  readonly project: string;
  readonly summary: string;
  /** ADF for Jira Cloud, wiki markup for Data Center, plain text for previews. */
  readonly description: { readonly adf: unknown; readonly wiki: string; readonly text: string };
  readonly components: readonly string[];
  readonly labels: readonly string[];
}

/**
 * The bug tracker of a project (REQ-PUB-07): search for similar open bugs, create a bug, link two issues. Every
 * text it receives has been masked; it is called only after the user confirmed (REQ-PUB-07/AC4).
 */
export interface BugTracker {
  findSimilar(search: BugSearch, signal?: AbortSignal): Promise<readonly BugMatch[]>;
  createBug(
    draft: BugDraft,
    signal?: AbortSignal,
  ): Promise<{ readonly key: string; readonly url?: string | undefined }>;
  /** Links `from` to `to` with a "relates to" link. */
  link(from: string, to: string, signal?: AbortSignal): Promise<void>;
}
