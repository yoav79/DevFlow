import type { OpenCodeProcessResult } from "./opencode-process-runner.js";
import {
  parseOpenCodeOutput,
  OpenCodeOutputParseError,
} from "./opencode-output-parser.js";
import {
  parseAgentEnvelope,
  AgentProtocolParseError,
} from "./agent-protocol.js";
import {
  parseSupervisorAgentResult,
  SupervisorPayloadValidationError,
  SupervisorPayloadSemanticError,
} from "./supervisor-agent-payload.js";
import type { SupervisorResult } from "../types.js";

const STDERR_PREVIEW_MAX_CHARS = 400;

export interface SupervisorOpenCodeInterpretation {
  readonly supervisorResult: SupervisorResult;
  readonly sessionID: string | null;
  readonly messageID: string;
}

export type SupervisorOpenCodeInterpretationErrorCode =
  | "PROCESS_EXIT_NOT_ZERO"
  | "PROCESS_EXIT_UNKNOWN"
  | "PROCESS_SIGNALED"
  | "OUTPUT_PARSE_FAILED"
  | "OUTPUT_NOT_FINISHED"
  | "PROTOCOL_PARSE_FAILED"
  | "ROLE_MISMATCH"
  | "AGENT_STATUS_NOT_ACCEPTED"
  | "SUPERVISOR_PAYLOAD_INVALID"
  | "SUPERVISOR_PAYLOAD_SEMANTIC_ERROR";

export class SupervisorOpenCodeInterpretationError extends Error {
  readonly code: SupervisorOpenCodeInterpretationErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly hasStderr: boolean;
  readonly stderrTruncated: boolean;
  readonly stderrPreview?: string;
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: SupervisorOpenCodeInterpretationErrorCode;
      result: OpenCodeProcessResult;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "SupervisorOpenCodeInterpretationError";
    this.code = options.code;
    this.exitCode = options.result.exitCode;
    this.signal = options.result.signal;
    this.hasStderr = options.result.stderr.length > 0;
    this.stderrTruncated = options.result.stderrTruncated;

    if (this.hasStderr) {
      this.stderrPreview = options.result.stderr.slice(0, STDERR_PREVIEW_MAX_CHARS);
    }

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function toInterpretationError(
  message: string,
  code: SupervisorOpenCodeInterpretationErrorCode,
  result: OpenCodeProcessResult,
  cause?: unknown,
): SupervisorOpenCodeInterpretationError {
  return new SupervisorOpenCodeInterpretationError(message, {
    code,
    result,
    cause,
  });
}

export function interpretSupervisorOpenCodeResult(
  result: OpenCodeProcessResult,
): SupervisorOpenCodeInterpretation {
  if (result.stdoutTruncated || result.timedOut || result.aborted) {
    try {
      parseOpenCodeOutput(result);
    } catch (error) {
      if (error instanceof OpenCodeOutputParseError) {
        throw toInterpretationError(
          "No se pudo interpretar la salida de OpenCode del supervisor.",
          "OUTPUT_PARSE_FAILED",
          result,
          error,
        );
      }

      throw error;
    }
  }

  if (result.signal !== null) {
    throw toInterpretationError(
      "El proceso del supervisor terminó por signal.",
      "PROCESS_SIGNALED",
      result,
    );
  }

  if (result.exitCode === null) {
    throw toInterpretationError(
      "El proceso del supervisor terminó sin exit code.",
      "PROCESS_EXIT_UNKNOWN",
      result,
    );
  }

  if (result.exitCode !== 0) {
    throw toInterpretationError(
      "El proceso del supervisor terminó con exit code no exitoso.",
      "PROCESS_EXIT_NOT_ZERO",
      result,
    );
  }

  const parsedOutput = (() => {
    try {
      return parseOpenCodeOutput(result);
    } catch (error) {
      if (error instanceof OpenCodeOutputParseError) {
        throw toInterpretationError(
          "No se pudo interpretar la salida de OpenCode del supervisor.",
          "OUTPUT_PARSE_FAILED",
          result,
          error,
        );
      }

      throw error;
    }
  })();

  if (parsedOutput.finished !== true) {
    throw toInterpretationError(
      "La salida del supervisor no está finalizada.",
      "OUTPUT_NOT_FINISHED",
      result,
    );
  }

  const envelope = (() => {
    try {
      return parseAgentEnvelope(parsedOutput.assistantText);
    } catch (error) {
      if (error instanceof AgentProtocolParseError) {
        throw toInterpretationError(
          "No se pudo interpretar el envelope del supervisor.",
          "PROTOCOL_PARSE_FAILED",
          result,
          error,
        );
      }

      throw error;
    }
  })();

  if (envelope.status !== "COMPLETED") {
    throw toInterpretationError(
      `El supervisor devolvió un status no aceptado: ${envelope.status}.`,
      "AGENT_STATUS_NOT_ACCEPTED",
      result,
    );
  }

  const supervisorResult = (() => {
    try {
      return parseSupervisorAgentResult(envelope);
    } catch (error) {
      if (error instanceof AgentProtocolParseError && error.code === "ROLE_MISMATCH") {
        throw toInterpretationError(
          "El envelope no corresponde al role supervisor.",
          "ROLE_MISMATCH",
          result,
          error,
        );
      }

      if (error instanceof SupervisorPayloadValidationError) {
        throw toInterpretationError(
          "El payload del supervisor es inválido.",
          "SUPERVISOR_PAYLOAD_INVALID",
          result,
          error,
        );
      }

      if (error instanceof SupervisorPayloadSemanticError) {
        throw toInterpretationError(
          "El payload del supervisor es semánticamente inválido.",
          "SUPERVISOR_PAYLOAD_SEMANTIC_ERROR",
          result,
          error,
        );
      }

      throw error;
    }
  })();

  return {
    supervisorResult,
    sessionID: parsedOutput.sessionID,
    messageID: parsedOutput.messageID,
  };
}
