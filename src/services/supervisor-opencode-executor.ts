import { runOpenCodeProcess, type OpenCodeProcessInput, type OpenCodeProcessResult } from "./opencode-process-runner.js";
import { interpretSupervisorOpenCodeResult, type SupervisorOpenCodeInterpretation } from "./supervisor-opencode-integration.js";
import { buildSupervisorPrompt, type SupervisorPromptInput } from "./supervisor-prompt-builder.js";

export interface SupervisorRuntimeOptions {
  readonly timeoutMs: number;
  readonly agent?: string;
  readonly model?: string;
  readonly binaryPath?: string;
  readonly signal?: AbortSignal;
}

export interface SupervisorExecutorDeps {
  readonly runProcess?: typeof runOpenCodeProcess;
  readonly interpretResult?: typeof interpretSupervisorOpenCodeResult;
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
  input: SupervisorPromptInput,
  runtime: SupervisorRuntimeOptions,
  prompt: string,
): OpenCodeProcessInput {
  const agent = validateOverride(runtime.agent, "El agente") ?? "supervisor";
  const model = validateOverride(runtime.model, "El modelo");

  return {
    cwd: input.project.repositoryPath,
    prompt,
    agent,
    timeoutMs: runtime.timeoutMs,
    ...(model !== undefined ? { model } : {}),
    ...(runtime.binaryPath !== undefined ? { binaryPath: runtime.binaryPath } : {}),
    ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
  };
}

export async function runSupervisorWithOpenCode(
  input: SupervisorPromptInput,
  runtime: SupervisorRuntimeOptions,
  deps?: SupervisorExecutorDeps,
): Promise<SupervisorOpenCodeInterpretation> {
  const prompt = buildSupervisorPrompt(input);
  const runProcess = deps?.runProcess ?? runOpenCodeProcess;
  const interpretResult = deps?.interpretResult ?? interpretSupervisorOpenCodeResult;
  const processInput = buildRunnerInput(input, runtime, prompt);
  const processResult: OpenCodeProcessResult = await runProcess(processInput);

  return interpretResult(processResult);
}
