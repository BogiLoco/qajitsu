import type { Guard } from "@qajitsu/guard";
import type { ResolvedModel } from "@qajitsu/models";
import {
  Output,
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { AgentOutputError } from "./errors.js";
import type { UsageTracker } from "./usage.js";

/** A tool an agent may call. Execution happens only after the guard allows it (REQ-VER-03/AC3). */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** Maximum validation rounds before a stage fails (REQ-LLM-04/AC2). */
export const MAX_OUTPUT_ATTEMPTS = 3;

const summarize = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

/**
 * Wraps agent tools so every call goes through the guard first and its result is journaled
 * (REQ-VER-03/AC3, REQ-VER-04). A denied call returns the reason to the model instead of running.
 *
 * @param tools - Tools of the role.
 * @param guard - Guard bound to the run and stage.
 * @param signal - Cancels running tools.
 */
export function guardTools(tools: readonly AgentTool[], guard: Guard, signal?: AbortSignal): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input: Record<string, unknown>) => {
        const call = { tool: t.name, input };
        const decision = guard.check(call);
        if (!decision.allowed) return `DENIED (${decision.code}): ${decision.reason}`;
        try {
          const output = await t.execute(input, signal);
          guard.recordResult(call, summarize(output));
          return output;
        } catch (error) {
          const message = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          guard.recordResult(call, message);
          return message;
        }
      },
    });
  }
  return set;
}

/**
 * Extracts the JSON object from a model answer: a fenced block or the outermost braces.
 *
 * @param text - Model output.
 * @throws {SyntaxError} When there is no parsable JSON object.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (candidate.trim() === "") throw new SyntaxError("No JSON object found in the answer.");
  return JSON.parse(candidate) as unknown;
}

const DECODING_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "additionalProperties",
  "description",
]);

/**
 * JSON Schema for constrained decoding: only structure (types, properties, required, enums).
 * Patterns, formats and lengths are dropped because local runtimes cannot compile every regex into a
 * grammar; the full Zod schema still validates the answer afterwards (REQ-LLM-04/AC1).
 *
 * @param schema - Zod schema of the answer.
 */
export function decodingSchema(schema: z.ZodType): JSONSchema7 {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!DECODING_KEYS.has(key)) continue;
      out[key] =
        key === "properties" && value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strip(v)]),
            )
          : strip(value);
    }
    return out;
  };
  return strip(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as JSONSchema7;
}

/** Inputs of one structured agent run. */
export interface StructuredRun<T extends z.ZodType> {
  readonly stage: string;
  readonly role: string;
  readonly model: ResolvedModel;
  readonly system: string;
  readonly prompt: string;
  readonly schema: T;
  /** Extra deterministic checks (e.g. grounded sources); returned strings are sent back as errors. */
  readonly validate?: (value: z.infer<T>) => readonly string[];
  readonly tools?: readonly AgentTool[];
  readonly guard?: Guard;
  readonly usage: UsageTracker;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs an agent whose final answer must be JSON matching `schema` (REQ-LLM-04). Invalid output is
 * returned to the agent with the validation errors, up to {@link MAX_OUTPUT_ATTEMPTS} attempts; then
 * the stage fails with {@link AgentOutputError}, never with a guessed value. Repair rounds on models
 * with native structured output decode against the JSON Schema and drop tools: exploration already
 * happened, and constrained decoding fixes shape errors (REQ-LLM-04/AC3).
 *
 * @returns The validated value and the number of attempts used.
 * @throws {AgentOutputError} `AGENT_OUTPUT_INVALID` with the last errors.
 */
export async function runStructuredAgent<T extends z.ZodType>(
  run: StructuredRun<T>,
): Promise<{ value: z.infer<T>; attempts: number }> {
  const tools =
    run.tools && run.guard && run.model.profile.tools
      ? guardTools(run.tools, run.guard, run.signal)
      : undefined;
  let messages: ModelMessage[] = [{ role: "user", content: run.prompt }];
  let lastErrors: readonly string[] = [];
  let constrainedAvailable = run.model.profile.structuredOutput;
  for (let attempt = 1; attempt <= MAX_OUTPUT_ATTEMPTS; attempt += 1) {
    const constrained = attempt > 1 && constrainedAvailable;
    let result;
    try {
      result = await generateText({
        model: run.model.model,
        system: run.system,
        messages,
        ...(constrained
          ? { output: Output.object({ schema: jsonSchema(decodingSchema(run.schema)), name: run.role }) }
          : {}),
        ...(tools && !constrained ? { tools, stopWhen: stepCountIs(run.maxSteps ?? 12) } : {}),
        ...(run.signal ? { abortSignal: run.signal } : {}),
        maxRetries: 2,
      });
    } catch (error) {
      if (!constrained || run.signal?.aborted || !(error instanceof Error)) throw error;
      if (!/No (object|output) generated/i.test(error.message)) {
        // The provider rejected constrained decoding (e.g. a grammar it cannot compile): keep JSON mode.
        constrainedAvailable = false;
      }
      lastErrors = [`Structured output failed: ${error.message.split("\n")[0] ?? ""}`];
      messages = [
        ...messages,
        {
          role: "user",
          content: "Your answer could not be parsed. Answer again with the complete JSON object only.",
        },
      ];
      continue;
    }
    run.usage.record(run.stage, run.role, run.model.id, run.model.profile, {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    });
    let errors: string[];
    try {
      const parsed = run.schema.safeParse(extractJson(result.text));
      if (parsed.success) {
        errors = [...(run.validate?.(parsed.data) ?? [])];
        if (errors.length === 0) return { value: parsed.data, attempts: attempt };
      } else {
        errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      }
    } catch (error) {
      errors = [`Answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
    }
    lastErrors = errors;
    messages = [
      ...messages,
      ...result.responseMessages,
      {
        role: "user",
        content: `Your answer was rejected (attempt ${String(attempt)} of ${String(MAX_OUTPUT_ATTEMPTS)}). Fix exactly these problems and answer again with the complete JSON object only:\n${errors.map((e) => `- ${e}`).join("\n")}`,
      },
    ];
  }
  throw new AgentOutputError(
    "AGENT_OUTPUT_INVALID",
    `${run.role} did not produce valid output in ${String(MAX_OUTPUT_ATTEMPTS)} attempts.`,
    { role: run.role, errors: lastErrors.slice(0, 20) },
  );
}
