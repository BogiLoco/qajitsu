/** Result of the ticket readiness gate (REQ-PLAN-13/AC4). */
export type Readiness = "READY" | "NEEDS_CLARIFICATION" | "NOT_TESTABLE";

/** Risk level of a change (REQ-PLAN-13/AC5). */
export type RiskLevel = "low" | "medium" | "high";

/** A rule that sets the risk of a change from the paths it touches. */
export interface RiskRule {
  /** Regular expression over a changed file's path (case-insensitive). */
  readonly pattern: string;
  readonly level: RiskLevel;
  readonly reason: string;
}

/**
 * Built-in risk rules (REQ-PLAN-13/AC5): schema migrations, authentication and security code, payments, and the
 * infrastructure that builds or deploys the application. A project adds its own in `readiness.risk_rules`.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  {
    pattern: "(^|/)(migrations?|db/migrate|alembic|flyway|liquibase)/|\\.sql$|schema\\.prisma$",
    level: "high",
    reason: "database migration",
  },
  {
    pattern:
      "auth|login|password|passwd|token|session|oauth|saml|jwt|crypto|permission|acl|rbac|security|secret",
    level: "high",
    reason: "authentication or security code",
  },
  { pattern: "payment|billing|checkout|invoice|refund|wallet", level: "high", reason: "payments" },
  {
    pattern:
      "(^|/)(dockerfile|docker-compose[^/]*|\\.github/workflows/|\\.gitlab-ci|terraform/|helm/|k8s/|kubernetes/)",
    level: "medium",
    reason: "build, deployment or infrastructure",
  },
];

/** What the gate looks at, read by the caller. */
export interface ReadinessInput {
  readonly ticket: {
    readonly summary: string;
    readonly description: string;
    readonly acceptanceCriteria: readonly string[];
    readonly labels?: readonly string[];
    readonly components?: readonly string[];
  };
  /** `code.access` of the project (REQ-CTX-10). */
  readonly codeAccess: "full" | "metadata" | "none";
  /** Changes found for the ticket (PR/MR or branch per repository). */
  readonly changes: number;
  /** Paths the change touches, when code access allows knowing them. */
  readonly changedFiles: readonly string[];
  /** An environment to test in is configured or given. */
  readonly environmentKnown: boolean;
  /** The analyst's view, when it ran: its confidence, open questions and risks (reasons only, REQ-PLAN-13/AC5). */
  readonly analysis?: {
    readonly confidence: "high" | "medium" | "low";
    readonly open_questions: readonly { readonly id?: string; readonly question: string }[];
    readonly risks: readonly { readonly description: string }[];
  };
  readonly rules?: readonly RiskRule[];
}

/** The gate's verdict (REQ-PLAN-13/AC1+AC4+AC5). */
export interface ReadinessResult {
  readonly result: Readiness;
  readonly risk: RiskLevel;
  /** Why the risk is what it is: the rules that matched, then the analyst's reasons. */
  readonly riskReasons: readonly string[];
  /** What the ticket does not say that testing it needs. */
  readonly gaps: readonly string[];
  /** Concrete questions to the ticket's author, one per gap that blocks planning. */
  readonly questions: readonly string[];
}

const LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];
const higher = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

/**
 * The ticket readiness gate (REQ-PLAN-13): before planning, code checks that the ticket can be tested at all. A
 * ticket with neither acceptance criteria nor a description is NOT_TESTABLE; one without acceptance criteria, without
 * a found change (when code may be read), or that the analyst understood with low confidence, NEEDS_CLARIFICATION,
 * with a concrete question for each. A missing default environment is a gap, not a question for the ticket's author. The risk level comes from rules over the changed paths, the
 * size of the change and the ticket's labels and components; the analyst's risks are added as reasons and never
 * lower it.
 *
 * @param input - The ticket, the change and the analyst's view.
 */
export function checkReadiness(input: ReadinessInput): ReadinessResult {
  const t = input.ticket;
  const criteria = t.acceptanceCriteria.filter((c) => c.trim() !== "");
  const described = `${t.summary} ${t.description}`.trim().length >= 30;
  const questions: string[] = [];
  const gaps: string[] = [];
  if (criteria.length === 0) {
    gaps.push("no acceptance criteria");
    questions.push("What must be true when this ticket is done? Please add acceptance criteria.");
  }
  if (input.codeAccess !== "none" && input.changes === 0) {
    gaps.push("no change found for the ticket");
    questions.push("Which pull or merge request, or branch, implements this ticket?");
  }
  // A question for QA, not for the ticket's author: the plan does not need it, `qj run --env` names it later.
  if (!input.environmentKnown)
    gaps.push("no default environment yet: set environments.default or pass --env to qj run");
  if (input.analysis?.confidence === "low") {
    gaps.push("the scope is not clear enough to plan");
    for (const q of input.analysis.open_questions) questions.push(q.question);
  } else for (const q of input.analysis?.open_questions ?? []) gaps.push(`open question: ${q.question}`);
  const result: Readiness =
    criteria.length === 0 && !described
      ? "NOT_TESTABLE"
      : questions.length > 0
        ? "NEEDS_CLARIFICATION"
        : "READY";

  let risk: RiskLevel = "low";
  const riskReasons: string[] = [];
  const raise = (level: RiskLevel, reason: string): void => {
    risk = higher(risk, level);
    riskReasons.push(`${level}: ${reason}`);
  };
  for (const rule of [...DEFAULT_RISK_RULES, ...(input.rules ?? [])]) {
    const re = new RegExp(rule.pattern, "i");
    const hits = input.changedFiles.filter((f) => re.test(f));
    if (hits.length > 0)
      raise(rule.level, `${rule.reason} (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", …" : ""})`);
  }
  const files = input.changedFiles.length;
  if (files > 50) raise("high", `a large change (${String(files)} files)`);
  else if (files > 20) raise("medium", `a broad change (${String(files)} files)`);
  for (const tag of [...(t.labels ?? []), ...(t.components ?? [])])
    if (/security|auth|payment|billing|privacy|gdpr/i.test(tag))
      raise("high", `the ticket is marked "${tag}"`);
  if (input.codeAccess === "none")
    riskReasons.push("the change itself could not be looked at (code access none)");
  // The analyst may say more, never less.
  for (const r of input.analysis?.risks ?? []) riskReasons.push(`analyst: ${r.description}`);
  return { result, risk, riskReasons, gaps, questions };
}

/** The readiness result as lines for the terminal and the ticket comment (REQ-PLAN-13/AC4). */
export function formatReadiness(r: ReadinessResult): string[] {
  return [
    `Readiness: ${r.result} · risk ${r.risk}`,
    ...r.riskReasons.map((x) => `  risk ${x}`),
    ...r.gaps.map((g) => `  gap: ${g}`),
    ...(r.questions.length > 0
      ? ["Questions before testing:", ...r.questions.map((q, i) => `  ${String(i + 1)}. ${q}`)]
      : []),
  ];
}
