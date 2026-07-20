import { runOpenCodeProcess, type OpenCodeProcessInput, type OpenCodeProcessResult } from "./opencode-process-runner.js";
import { interpretExecutorOpenCodeResult, type ExecutorOpenCodeInterpretation } from "./executor-opencode-integration.js";
import { buildExecutorPrompt, type ExecutorPromptInput } from "./executor-prompt-builder.js";

export interface ExecutorRuntimeOptions {
  readonly timeoutMs: number;
  readonly agent?: string;
  readonly model?: string;
  readonly binaryPath?: string;
  readonly signal?: AbortSignal;
}

export interface ExecutorExecutorDeps {
  readonly runProcess?: typeof runOpenCodeProcess;
  readonly interpretResult?: typeof interpretExecutorOpenCodeResult;
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
  input: ExecutorPromptInput,
  runtime: ExecutorRuntimeOptions,
  prompt: string,
): OpenCodeProcessInput {
  const agent = validateOverride(runtime.agent, "El agente") ?? "executor";
  const model = validateOverride(runtime.model, "El modelo");

  return {
    cwd: input.workspace.workspacePath,
    prompt,
    agent,
    timeoutMs: runtime.timeoutMs,
    ...(model !== undefined ? { model } : {}),
    ...(runtime.binaryPath !== undefined ? { binaryPath: runtime.binaryPath } : {}),
    ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
  };
}

export async function runExecutorWithOpenCode(
  input: ExecutorPromptInput,
  runtime: ExecutorRuntimeOptions,
  deps?: ExecutorExecutorDeps,
): Promise<ExecutorOpenCodeInterpretation> {
  const prompt = buildExecutorPrompt(input);
  const runProcess = deps?.runProcess ?? runOpenCodeProcess;
  const interpretResult = deps?.interpretResult ?? interpretExecutorOpenCodeResult;
  const processInput = buildRunnerInput(input, runtime, prompt);
  const processResult: OpenCodeProcessResult = await runProcess(processInput);

  return interpretResult(processResult);
}
