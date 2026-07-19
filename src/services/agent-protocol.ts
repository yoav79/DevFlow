import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AGENT_PROTOCOL_VERSION = 1 as const;

export const AGENT_ROLES = [
  "supervisor",
  "executor",
  "reviewer",
  "next-task",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Agent protocol statuses represent the semantic outcome reported by the agent.
 *
 * - `COMPLETED`: the agent finished its operation successfully.
 *   This does NOT equate to `TaskState.COMPLETED`.
 * - `NEEDS_INPUT`: the agent requires human input to proceed.
 * - `BLOCKED`: the agent is blocked and cannot continue.
 * - `FAILED`: a semantic failure reported by the agent.
 *   This does NOT replace process runner or parser failures.
 */
export const AGENT_PROTOCOL_STATUSES = [
  "COMPLETED",
  "NEEDS_INPUT",
  "BLOCKED",
  "FAILED",
] as const;

export type AgentProtocolStatus = (typeof AGENT_PROTOCOL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Envelope interface
// ---------------------------------------------------------------------------

export interface AgentEnvelope {
  readonly protocolVersion: 1;
  readonly role: AgentRole;
  readonly status: AgentProtocolStatus;
  readonly summary: string;
  readonly questions: readonly string[];
  readonly risks: readonly string[];
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const nonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, {
    message: "String must not be empty or whitespace only",
  });

export const agentRoleSchema = z.enum([
  "supervisor",
  "executor",
  "reviewer",
  "next-task",
]);

export const agentProtocolStatusSchema = z.enum([
  "COMPLETED",
  "NEEDS_INPUT",
  "BLOCKED",
  "FAILED",
]);

/**
 * Schema for the agent envelope.
 *
 * - `protocolVersion` must be exactly `1`.
 * - `payload` must exist (reject `undefined`), but accepts any JSON value.
 * - Strict: no additional properties allowed.
 */
export const agentEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    role: agentRoleSchema,
    status: agentProtocolStatusSchema,
    summary: nonEmptyStringSchema,
    questions: z.array(nonEmptyStringSchema),
    risks: z.array(nonEmptyStringSchema),
    payload: z
      .unknown()
      .refine((v) => v !== undefined, { message: "payload is required" }),
  })
  .strict();

// ---------------------------------------------------------------------------
// Public issue type (normalised from Zod)
// ---------------------------------------------------------------------------

export interface AgentProtocolIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type AgentProtocolParseErrorCode =
  | "EMPTY_ASSISTANT_TEXT"
  | "INVALID_JSON"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "ROLE_MISMATCH";

export class AgentProtocolParseError extends Error {
  readonly code: AgentProtocolParseErrorCode;
  readonly issues?: readonly AgentProtocolIssue[];
  readonly expectedRole?: AgentRole;
  readonly receivedRole?: string;

  constructor(
    message: string,
    options: {
      code: AgentProtocolParseErrorCode;
      issues?: readonly AgentProtocolIssue[];
      expectedRole?: AgentRole;
      receivedRole?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "AgentProtocolParseError";
    this.code = options.code;
    if (options.issues !== undefined) {
      this.issues = options.issues;
    }
    if (options.expectedRole !== undefined) {
      this.expectedRole = options.expectedRole;
    }
    if (options.receivedRole !== undefined) {
      this.receivedRole = options.receivedRole;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseZodIssues(
  issues: readonly z.ZodIssue[],
): AgentProtocolIssue[] {
  return issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number"),
    code: issue.code,
    message: issue.message,
  }));
}

function hasOwnProtocolVersion(value: object): boolean {
  return "protocolVersion" in value;
}

// ---------------------------------------------------------------------------
// parseAgentEnvelope
// ---------------------------------------------------------------------------

/**
 * Parse a raw assistant text string into a validated `AgentEnvelope`.
 *
 * Policy:
 * - `text` is trimmed; if empty, `EMPTY_ASSISTANT_TEXT`.
 * - The entire trimmed string must be valid JSON (pure object).
 * - No markdown fences, no partial extraction, no heuristic search.
 * - Schema validation via `agentEnvelopeSchema` (strict).
 * - Version mismatch yields `UNSUPPORTED_PROTOCOL_VERSION`.
 * - Any other schema failure yields `INVALID_ENVELOPE`.
 */
export function parseAgentEnvelope(text: string): AgentEnvelope {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new AgentProtocolParseError(
      "El texto del assistant está vacío.",
      { code: "EMPTY_ASSISTANT_TEXT" },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new AgentProtocolParseError(
      "El texto del assistant no es JSON válido.",
      { code: "INVALID_JSON", cause },
    );
  }

  const result = agentEnvelopeSchema.safeParse(parsed);

  if (result.success) {
    return result.data as AgentEnvelope;
  }

  // Classify: UNSUPPORTED_PROTOCOL_VERSION vs INVALID_ENVELOPE
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    hasOwnProtocolVersion(parsed as object)
  ) {
    const pv = (parsed as Record<string, unknown>).protocolVersion;

    if (pv !== 1) {
      throw new AgentProtocolParseError(
        "Versión de protocolo no soportada.",
        {
          code: "UNSUPPORTED_PROTOCOL_VERSION",
          issues: normaliseZodIssues(result.error.issues),
        },
      );
    }
  }

  throw new AgentProtocolParseError(
    "El envelope del agente no es válido.",
    {
      code: "INVALID_ENVELOPE",
      issues: normaliseZodIssues(result.error.issues),
    },
  );
}

// ---------------------------------------------------------------------------
// assertAgentEnvelopeRole
// ---------------------------------------------------------------------------

/**
 * Assert that an envelope has the expected role.
 *
 * - Does not re-parse or re-validate the envelope.
 * - Does not mutate the envelope.
 * - Returns the same reference if roles match.
 * - Throws `ROLE_MISMATCH` if roles differ.
 */
export function assertAgentEnvelopeRole(
  envelope: AgentEnvelope,
  expectedRole: AgentRole,
): AgentEnvelope {
  if (envelope.role === expectedRole) {
    return envelope;
  }

  throw new AgentProtocolParseError(
    `Role esperado "${expectedRole}", recibido "${envelope.role}".`,
    {
      code: "ROLE_MISMATCH",
      expectedRole,
      receivedRole: envelope.role,
    },
  );
}
