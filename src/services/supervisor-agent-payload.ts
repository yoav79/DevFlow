import { z } from "zod";
import {
  assertAgentEnvelopeRole,
  type AgentEnvelope,
} from "./agent-protocol.js";
import type { SupervisorResult } from "../types.js";
import {
  validateSupervisorResultSemantics,
  SupervisorResultSemanticError,
} from "./supervisor-result-semantic-validator.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, {
    message: "String must not be empty or whitespace only",
  });

const nonEmptyStringArray = z.array(nonEmptyString);

const supervisorExecutableTaskSchema = z
  .object({
    classification: z.literal("EXECUTABLE_TASK"),
    reasoning: nonEmptyString,
    objective: nonEmptyString,
    context: nonEmptyString,
    acceptanceCriteria: nonEmptyStringArray.min(1),
    allowedPaths: z.array(nonEmptyString),
    forbiddenPaths: z.array(nonEmptyString),
    requiredCommands: z.array(nonEmptyString),
    assumptions: z.array(nonEmptyString),
    risks: z.array(nonEmptyString),
    openQuestions: z.tuple([]),
  })
  .strict();

const suggestedTaskSchema = z
  .object({
    title: nonEmptyString,
    objective: nonEmptyString,
  })
  .strict();

const supervisorDecompositionSchema = z
  .object({
    classification: z.literal("NEEDS_DECOMPOSITION"),
    reasoning: nonEmptyString,
    decompositionReason: nonEmptyString,
    suggestedTasks: z.array(suggestedTaskSchema).min(1),
    openQuestions: z.array(nonEmptyString),
  })
  .strict();

const supervisorDiscoverySchema = z
  .object({
    classification: z.literal("NEEDS_DISCOVERY"),
    reasoning: nonEmptyString,
    missingInformation: nonEmptyStringArray.min(1),
    recommendedDiscoveryActions: nonEmptyStringArray.min(1),
    openQuestions: z.array(nonEmptyString),
  })
  .strict();

export const supervisorAgentPayloadSchema = z.discriminatedUnion(
  "classification",
  [
    supervisorExecutableTaskSchema,
    supervisorDecompositionSchema,
    supervisorDiscoverySchema,
  ],
);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SupervisorExecutableTaskPayload {
  readonly classification: "EXECUTABLE_TASK";
  readonly reasoning: string;
  readonly objective: string;
  readonly context: string;
  readonly acceptanceCriteria: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly requiredCommands: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly openQuestions: readonly [];
}

export interface SupervisorDecompositionPayload {
  readonly classification: "NEEDS_DECOMPOSITION";
  readonly reasoning: string;
  readonly decompositionReason: string;
  readonly suggestedTasks: readonly {
    readonly title: string;
    readonly objective: string;
  }[];
  readonly openQuestions: readonly string[];
}

export interface SupervisorDiscoveryPayload {
  readonly classification: "NEEDS_DISCOVERY";
  readonly reasoning: string;
  readonly missingInformation: readonly string[];
  readonly recommendedDiscoveryActions: readonly string[];
  readonly openQuestions: readonly string[];
}

export type SupervisorAgentPayload =
  | SupervisorExecutableTaskPayload
  | SupervisorDecompositionPayload
  | SupervisorDiscoveryPayload;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface SupervisorPayloadIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export class SupervisorPayloadValidationError extends Error {
  readonly issues: readonly SupervisorPayloadIssue[];

  constructor(
    issues: SupervisorPayloadIssue[],
    options?: { cause?: unknown },
  ) {
    const count = issues.length;
    super(
      `Payload del supervisor inválido: ${count} error(es) de validación.`,
    );
    this.name = "SupervisorPayloadValidationError";
    this.issues = issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class SupervisorPayloadSemanticError extends Error {
  readonly issues: readonly SupervisorPayloadIssue[];

  constructor(
    issues: SupervisorPayloadIssue[],
    options?: { cause?: unknown },
  ) {
    const count = issues.length;
    super(
      `Payload del supervisor semánticamente inválido: ${count} error(es).`,
    );
    this.name = "SupervisorPayloadSemanticError";
    this.issues = issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseZodIssues(
  issues: readonly z.ZodIssue[],
): SupervisorPayloadIssue[] {
  return issues.map((issue) => ({
    path: issue.path.filter(
      (p): p is string | number =>
        typeof p === "string" || typeof p === "number",
    ),
    code: issue.code,
    message: issue.message,
  }));
}

// ---------------------------------------------------------------------------
// API 1: parseSupervisorPayload
// ---------------------------------------------------------------------------

/**
 * Validate raw payload against the supervisor payload schema.
 *
 * - Strict discriminated union on `classification`.
 * - No role validation, no status validation, no semantic validation.
 * - Does not mutate input.
 */
export function parseSupervisorPayload(
  payload: unknown,
): SupervisorAgentPayload {
  const result = supervisorAgentPayloadSchema.safeParse(payload);

  if (result.success) {
    return result.data as SupervisorAgentPayload;
  }

  const issues = normaliseZodIssues(result.error.issues);
  throw new SupervisorPayloadValidationError(issues, { cause: result.error });
}

// ---------------------------------------------------------------------------
// API 2: toSupervisorResult
// ---------------------------------------------------------------------------

/**
 * Adapt a validated SupervisorAgentPayload into a SupervisorResult.
 *
 * - Copies `summary` from `envelope.summary`.
 * - Copies all other fields from `payload`.
 * - Creates new mutable arrays for compatibility with SupervisorResult.
 * - Does not validate role, status, or semantics.
 * - Does not mutate envelope or payload.
 */
export function toSupervisorResult(
  envelope: Pick<AgentEnvelope, "summary">,
  payload: SupervisorAgentPayload,
): SupervisorResult {
  const { summary } = envelope;

  switch (payload.classification) {
    case "EXECUTABLE_TASK":
      return {
        classification: "EXECUTABLE_TASK",
        summary,
        reasoning: payload.reasoning,
        objective: payload.objective,
        context: payload.context,
        acceptanceCriteria: [...payload.acceptanceCriteria],
        allowedPaths: [...payload.allowedPaths],
        forbiddenPaths: [...payload.forbiddenPaths],
        requiredCommands: [...payload.requiredCommands],
        assumptions: [...payload.assumptions],
        risks: [...payload.risks],
        openQuestions: [],
      };

    case "NEEDS_DECOMPOSITION":
      return {
        classification: "NEEDS_DECOMPOSITION",
        summary,
        reasoning: payload.reasoning,
        decompositionReason: payload.decompositionReason,
        suggestedTasks: payload.suggestedTasks.map((t) => ({
          title: t.title,
          objective: t.objective,
        })),
        openQuestions: [...payload.openQuestions],
      };

    case "NEEDS_DISCOVERY":
      return {
        classification: "NEEDS_DISCOVERY",
        summary,
        reasoning: payload.reasoning,
        missingInformation: [...payload.missingInformation],
        recommendedDiscoveryActions: [...payload.recommendedDiscoveryActions],
        openQuestions: [...payload.openQuestions],
      };
  }
}

// ---------------------------------------------------------------------------
// API 3: parseSupervisorAgentResult
// ---------------------------------------------------------------------------

/**
 * Full pipeline: assert role, parse payload, adapt, validate semantics.
 *
 * 1. `assertAgentEnvelopeRole(envelope, "supervisor")` — propagates `AgentProtocolParseError`
 *    with `ROLE_MISMATCH` on mismatch.
 * 2. `parseSupervisorPayload(envelope.payload)` — throws
 *    `SupervisorPayloadValidationError` on structural failure.
 * 3. `toSupervisorResult(envelope, payload)` — pure adaptation.
 * 4. `validateSupervisorResultSemantics(result)` — throws
 *    `SupervisorResultSemanticError`; caught and wrapped as
 *    `SupervisorPayloadSemanticError`.
 */
export function parseSupervisorAgentResult(
  envelope: AgentEnvelope,
): SupervisorResult {
  assertAgentEnvelopeRole(envelope, "supervisor");

  const payload = parseSupervisorPayload(envelope.payload);

  const result = toSupervisorResult(envelope, payload);

  try {
    validateSupervisorResultSemantics(result);
  } catch (error) {
    if (error instanceof SupervisorResultSemanticError) {
      const issues: SupervisorPayloadIssue[] = error.issues.map((issue) => ({
        path: [...issue.path],
        code: issue.code,
        message: issue.message,
      }));
      throw new SupervisorPayloadSemanticError(issues, { cause: error });
    }
    throw error;
  }

  return result;
}
