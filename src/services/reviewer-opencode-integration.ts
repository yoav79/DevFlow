import {
  parseOpenCodeOutput,
  OpenCodeOutputParseError,
  type OpenCodeOutputParseInput,
} from "./opencode-output-parser.js";
import { parseReviewerResult, ReviewerResultValidationError } from "./reviewer-result-parser.js";
import type { ReviewerExecutionResult } from "./reviewer-opencode-executor.js";
import type { ReviewerResult } from "../schemas/reviewer-result-schema.js";

export type ReviewerOpenCodeInterpretationErrorCode =
  | "PROCESS_EXIT_NOT_ZERO"
  | "PROCESS_EXIT_UNKNOWN"
  | "PROCESS_SIGNALED"
  | "OUTPUT_PARSE_FAILED"
  | "OUTPUT_NOT_FINISHED"
  | "REVIEWER_RESULT_INVALID";

export class ReviewerOpenCodeInterpretationError extends Error {
  readonly code: ReviewerOpenCodeInterpretationErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly hasStderr: boolean;
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: ReviewerOpenCodeInterpretationErrorCode;
      result: ReviewerExecutionResult;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ReviewerOpenCodeInterpretationError";
    this.code = options.code;
    this.exitCode = options.result.exitCode;
    this.signal = options.result.signal;
    this.timedOut = options.result.timedOut;
    this.aborted = options.result.aborted;
    this.durationMs = options.result.durationMs;
    this.hasStderr = options.result.stderr.length > 0;

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function toInterpretationError(
  message: string,
  code: ReviewerOpenCodeInterpretationErrorCode,
  result: ReviewerExecutionResult,
  cause?: unknown,
): ReviewerOpenCodeInterpretationError {
  return new ReviewerOpenCodeInterpretationError(message, {
    code,
    result,
    cause,
  });
}

export function interpretReviewerOpenCodeResult(
  result: ReviewerExecutionResult,
): ReviewerResult {
  if (result.signal !== null) {
    throw toInterpretationError(
      "El proceso del reviewer terminó por signal.",
      "PROCESS_SIGNALED",
      result,
    );
  }

  if (result.exitCode === null) {
    throw toInterpretationError(
      "El proceso del reviewer terminó sin exit code.",
      "PROCESS_EXIT_UNKNOWN",
      result,
    );
  }

  if (result.exitCode !== 0) {
    throw toInterpretationError(
      "El proceso del reviewer terminó con exit code no exitoso.",
      "PROCESS_EXIT_NOT_ZERO",
      result,
    );
  }

  const parseInput: OpenCodeOutputParseInput = {
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdoutTruncated: false,
  };

  const parsedOutput = (() => {
    try {
      return parseOpenCodeOutput(parseInput);
    } catch (error) {
      if (error instanceof OpenCodeOutputParseError) {
        throw toInterpretationError(
          "No se pudo interpretar la salida de OpenCode del reviewer.",
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
      "La salida del reviewer no está finalizada.",
      "OUTPUT_NOT_FINISHED",
      result,
    );
  }

  let json: unknown;

  try {
    json = JSON.parse(parsedOutput.assistantText);
  } catch (cause) {
    throw toInterpretationError(
      "La respuesta del reviewer no es JSON válido.",
      "REVIEWER_RESULT_INVALID",
      result,
      cause,
    );
  }

  try {
    return parseReviewerResult(json);
  } catch (error) {
    if (error instanceof ReviewerResultValidationError) {
      throw toInterpretationError(
        "El resultado del reviewer no es válido.",
        "REVIEWER_RESULT_INVALID",
        result,
        error,
      );
    }

    throw error;
  }
}
