import type { OpenCodeProcessResult } from "./opencode-process-runner.js";
import {
  parseOpenCodeOutput,
  type ParsedOpenCodeOutput,
} from "./opencode-output-parser.js";
import {
  parseAgentEnvelope,
  assertAgentEnvelopeRole,
  type AgentEnvelope,
} from "./agent-protocol.js";
import {
  parseSupervisorPayload,
  toSupervisorResult,
  type SupervisorAgentPayload,
} from "./supervisor-agent-payload.js";
import {
  validateSupervisorResultSemantics,
} from "./supervisor-result-semantic-validator.js";
import type { SupervisorResult } from "../types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SupervisorIntegrationResult {
  readonly supervisorResult: SupervisorResult;
  readonly parsedOutput: ParsedOpenCodeOutput;
  readonly envelope: AgentEnvelope;
  readonly payload: SupervisorAgentPayload;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type SupervisorIntegrationErrorCode =
  | "OUTPUT_PARSE_FAILED"
  | "ENVELOPE_PARSE_FAILED"
  | "ROLE_MISMATCH"
  | "PAYLOAD_PARSE_FAILED"
  | "SEMANTIC_VALIDATION_FAILED";

export class SupervisorIntegrationError extends Error {
  readonly code: SupervisorIntegrationErrorCode;
  readonly cause: unknown;

  constructor(
    message: string,
    options: {
      code: SupervisorIntegrationErrorCode;
      cause: unknown;
    },
  ) {
    super(message);
    this.name = "SupervisorIntegrationError";
    this.code = options.code;
    this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// Integration pipeline
// ---------------------------------------------------------------------------

/**
 * Parse an OpenCode process result through the full supervisor pipeline.
 *
 * Pipeline:
 * 1. `parseOpenCodeOutput` — extract assistant text from JSONL transport events
 * 2. `parseAgentEnvelope` — parse assistant text into a validated `AgentEnvelope`
 * 3. `assertAgentEnvelopeRole("supervisor")` — ensure role is supervisor
 * 4. `parseSupervisorPayload` — parse envelope payload into `SupervisorAgentPayload`
 * 5. `toSupervisorResult` — convert payload + envelope to `SupervisorResult`
 * 6. `validateSupervisorResultSemantics` — semantic validation (paths, duplicates, etc.)
 *
 * Each step wraps its native error in `SupervisorIntegrationError` with a
 * descriptive `code` while preserving the original error as `cause`.
 */
export function integrateSupervisorOutput(
  processResult: OpenCodeProcessResult,
): SupervisorIntegrationResult {
  let parsedOutput: ParsedOpenCodeOutput;

  try {
    parsedOutput = parseOpenCodeOutput(processResult);
  } catch (error) {
    throw new SupervisorIntegrationError(
      "No se pudo parsear la salida de OpenCode.",
      { code: "OUTPUT_PARSE_FAILED", cause: error },
    );
  }

  let envelope: AgentEnvelope;

  try {
    envelope = parseAgentEnvelope(parsedOutput.assistantText);
  } catch (error) {
    throw new SupervisorIntegrationError(
      "No se pudo parsear el envelope del agente.",
      { code: "ENVELOPE_PARSE_FAILED", cause: error },
    );
  }

  try {
    assertAgentEnvelopeRole(envelope, "supervisor");
  } catch (error) {
    throw new SupervisorIntegrationError(
      `Role esperado "supervisor", recibido "${envelope.role}".`,
      { code: "ROLE_MISMATCH", cause: error },
    );
  }

  let payload: SupervisorAgentPayload;

  try {
    payload = parseSupervisorPayload(envelope.payload);
  } catch (error) {
    throw new SupervisorIntegrationError(
      "No se pudo parsear el payload del supervisor.",
      { code: "PAYLOAD_PARSE_FAILED", cause: error },
    );
  }

  const supervisorResult = toSupervisorResult(envelope, payload);

  try {
    validateSupervisorResultSemantics(supervisorResult);
  } catch (error) {
    throw new SupervisorIntegrationError(
      "Validación semántica del supervisor falló.",
      { code: "SEMANTIC_VALIDATION_FAILED", cause: error },
    );
  }

  return { supervisorResult, parsedOutput, envelope, payload };
}
