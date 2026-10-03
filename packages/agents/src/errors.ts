import { QajitsuError } from "@qajitsu/core";

/** An agent did not produce valid output within its repair budget (REQ-LLM-04/AC2). */
export class AgentOutputError extends QajitsuError {}

/** The run's token budget is exhausted (REQ-LLM-07/AC2); the run ends BLOCKED. */
export class TokenBudgetExceededError extends QajitsuError {}
