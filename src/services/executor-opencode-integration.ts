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
  parseExecutorAgentResult,
  ExecutorPayloadValidationError,
  ExecutorPayloadSemanticError,
} from "./executor-agent-payload.js";
import type { AgentEnvelope } from "./agent-protocol.js";
import type { ExecutorAgentPayload } from "./executor-agent-payload.js";

const STDERR_PREVIEW_MAX_CHARS = 400;

export interface ExecutorOpenCodeInterpretation {
  readonly sessionID: string | null;
  readonly messageID: string;
  readonly envelope: AgentEnvelope;
  readonly executorPayload: ExecutorAgentPayload;
}

export type ExecutorOpenCodeInterpretationErrorCode =
  | "PROCESS_EXIT_NOT_ZERO"
  | "PROCESS_EXIT_UNKNOWN"
  | "PROCESS_SIGNALED"
  | "OUTPUT_NOT_FINISHED";

export class ExecutorOpenCodeInterpretationError extends Error {
  readonly code: ExecutorOpenCodeInterpretationErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly hasStderr: boolean;
  readonly stderrTruncated: boolean;
  readonly stderrPreview?: string;
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: ExecutorOpenCodeInterpretationErrorCode;
      result: OpenCodeProcessResult;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ExecutorOpenCodeInterpretationError";
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
  code: ExecutorOpenCodeInterpretationErrorCode,
  result: OpenCodeProcessResult,
  cause?: unknown,
): ExecutorOpenCodeInterpretationError {
  return new ExecutorOpenCodeInterpretationError(message, {
    code,
    result,
    cause,
  });
}

export function interpretExecutorOpenCodeResult(
  result: OpenCodeProcessResult,
): ExecutorOpenCodeInterpretation {
  if (result.stdoutTruncated || result.timedOut || result.aborted) {
    parseOpenCodeOutput(result);
  }

  if (result.signal !== null) {
    throw toInterpretationError(
      "El proceso del executor terminó por signal.",
      "PROCESS_SIGNALED",
      result,
    );
  }

  if (result.exitCode === null) {
    throw toInterpretationError(
      "El proceso del executor terminó sin exit code.",
      "PROCESS_EXIT_UNKNOWN",
      result,
    );
  }

  if (result.exitCode !== 0) {
    throw toInterpretationError(
      "El proceso del executor terminó con exit code no exitoso.",
      "PROCESS_EXIT_NOT_ZERO",
      result,
    );
  }

  const parsedOutput = parseOpenCodeOutput(result);

  if (parsedOutput.finished !== true) {
    throw toInterpretationError(
      "La salida del executor no está finalizada.",
      "OUTPUT_NOT_FINISHED",
      result,
    );
  }

  const envelope = parseAgentEnvelope(parsedOutput.assistantText);

  const executorPayload = parseExecutorAgentResult(envelope);

  return {
    sessionID: parsedOutput.sessionID,
    messageID: parsedOutput.messageID,
    envelope,
    executorPayload,
  };
}
