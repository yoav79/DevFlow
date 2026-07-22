import { runOpenCodeProcess, type OpenCodeProcessInput, type OpenCodeProcessResult, OpenCodeProcessError } from "./opencode-process-runner.js";
import { buildReviewerPrompt } from "./reviewer-prompt-builder.js";
import type { ReviewerPromptInput } from "../schemas/reviewer-prompt-input-schema.js";

export interface ReviewerRuntimeOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly agent?: string;
  readonly model?: string;
  readonly binaryPath?: string;
  readonly signal?: AbortSignal;
}

export interface ReviewerExecutorDeps {
  readonly buildPrompt?: typeof buildReviewerPrompt;
  readonly runProcess?: typeof runOpenCodeProcess;
}

export interface ReviewerExecutionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export type ReviewerExecutionErrorCode = "OUTPUT_TRUNCATED";

export class ReviewerExecutionError extends Error {
  readonly code: ReviewerExecutionErrorCode;
  readonly details: Readonly<{
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>;

  constructor(details: { stdoutTruncated: boolean; stderrTruncated: boolean }) {
    super("Output truncation detected.");
    this.name = "ReviewerExecutionError";
    this.code = "OUTPUT_TRUNCATED";
    this.details = Object.freeze({ ...details });
  }
}

function validateOverride(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} no puede estar vacío.`);
  }

  return trimmed;
}

function buildRunnerInput(
  input: ReviewerPromptInput,
  runtime: ReviewerRuntimeOptions,
  prompt: string,
): OpenCodeProcessInput {
  const agent = validateOverride(runtime.agent, "El agente") ?? "reviewer";
  const model = validateOverride(runtime.model, "El modelo");

  return {
    cwd: runtime.cwd,
    prompt,
    agent,
    timeoutMs: runtime.timeoutMs,
    ...(model !== undefined ? { model } : {}),
    ...(runtime.binaryPath !== undefined ? { binaryPath: runtime.binaryPath } : {}),
    ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
  };
}

export async function runReviewerWithOpenCode(
  input: ReviewerPromptInput,
  runtime: ReviewerRuntimeOptions,
  deps?: ReviewerExecutorDeps,
): Promise<ReviewerExecutionResult> {
  const prompt = (deps?.buildPrompt ?? buildReviewerPrompt)(input);
  const runProcess = deps?.runProcess ?? runOpenCodeProcess;
  const processInput = buildRunnerInput(input, runtime, prompt);
  const processResult: OpenCodeProcessResult = await runProcess(processInput);

  if (processResult.stdoutTruncated || processResult.stderrTruncated) {
    throw new ReviewerExecutionError({
      stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated,
    });
  }

  return {
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    durationMs: processResult.durationMs,
    timedOut: processResult.timedOut,
    aborted: processResult.aborted,
  };
}
