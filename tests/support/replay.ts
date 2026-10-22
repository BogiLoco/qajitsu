import { readFileSync } from "node:fs";
import type { Turn } from "./mock-model.js";

/** One line of a recorded agent transcript (`journal/agents.jsonl`), as far as a replay needs it. */
interface RecordedExchange {
  readonly seq: number;
  readonly role: string;
  readonly response: { readonly text: string };
}

/**
 * The answers of a recorded agent transcript as scripted model turns (REQ-LLM-14/AC5), in the order they were given:
 * a test plays a real model's output, invalid answers and repairs included, through today's parsers and checks,
 * without calling a model. Tool calls of a recorded exchange are not replayed, only its final answer.
 *
 * @param file - A transcript in the format of `journal/agents.jsonl` (requests may be left out).
 * @param roles - Only the answers of these roles.
 */
export function recordedAnswers(file: string | URL, roles?: readonly string[]): Turn[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RecordedExchange)
    .filter((e) => roles === undefined || roles.includes(e.role))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ text: e.response.text }));
}
