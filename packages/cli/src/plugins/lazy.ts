import type { BugTracker, Publisher, TicketWorkflow } from "@qajitsu/core";

/** One loading per wrapper: the first call starts it, later calls share it, a failure is repeated to every call. */
const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
};

/**
 * A publisher whose plugin loads on its first use (REQ-GEN-11/AC2): its id is known before, so a run can name it
 * without loading anything, and a missing plugin fails the first publish with the command that installs it.
 */
export function lazyPublisher(id: string, make: () => Promise<Publisher>): Publisher {
  const get = once(make);
  return { id, publish: async (input, signal) => (await get()).publish(input, signal) };
}

/** A bug tracker whose plugin loads on its first use (REQ-GEN-11/AC2). */
export function lazyBugTracker(make: () => Promise<BugTracker>): BugTracker {
  const get = once(make);
  return {
    findSimilar: async (search, signal) => (await get()).findSimilar(search, signal),
    createBug: async (draft, signal) => (await get()).createBug(draft, signal),
    link: async (from, to, signal) => (await get()).link(from, to, signal),
  };
}

/** A ticket workflow whose plugin loads on its first use (REQ-GEN-11/AC2). */
export function lazyWorkflow(id: string, make: () => Promise<TicketWorkflow>): TicketWorkflow {
  const get = once(make);
  return {
    id,
    status: async (ticket, signal) => (await get()).status(ticket, signal),
    transitions: async (ticket, signal) => (await get()).transitions(ticket, signal),
    transition: async (ticket, transitionId, signal) =>
      (await get()).transition(ticket, transitionId, signal),
    assign: async (ticket, account, signal) => (await get()).assign(ticket, account, signal),
    addLabel: async (ticket, label, signal) => (await get()).addLabel(ticket, label, signal),
    projectStatuses: async (projectKey, signal) => (await get()).projectStatuses(projectKey, signal),
    canTransition: async (projectKey, signal) => (await get()).canTransition(projectKey, signal),
    comments: async (ticket, signal) => (await get()).comments(ticket, signal),
    findInStatus: async (query, signal) => (await get()).findInStatus(query, signal),
    inGroup: async (account, group, signal) => (await get()).inGroup(account, group, signal),
  };
}
