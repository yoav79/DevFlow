import {
  detectGitChanges,
  type ChangedFile,
  type GitChangeDetectionResult,
} from "./git-change-detector.js";
import {
  validateChangedPaths,
  type PathValidationResult,
} from "./path-validation.js";
import {
  runRequiredCommands,
  type RequiredCommandRuntimeOptions,
  type RequiredCommandsExecutionResult,
} from "./required-command-runner.js";

export type RevisionStatus = "REVIEWING" | "REVISION_REQUIRED";

export interface DeterministicRevisionResult {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly pathValidation: PathValidationResult;
  readonly commandsResult: RequiredCommandsExecutionResult | null;
  readonly status: RevisionStatus;
  readonly generatedAt: string;
}

export interface DeterministicRevisionErrorContext {
  readonly code:
    | "INVALID_WORKSPACE_PATH"
    | "INVALID_BASE_COMMIT"
    | "INVALID_TASK_ID"
    | "INVALID_PROJECT_ID"
    | "INVALID_WORKSPACE_ID"
    | "INVALID_COMMANDS"
    | "GIT_DETECTION_FAILED"
    | "PATH_VALIDATION_FAILED"
    | "COMMAND_EXECUTION_FAILED";
  readonly message: string;
  readonly cause?: unknown;
}

export class DeterministicRevisionError extends Error {
  readonly code: DeterministicRevisionErrorContext["code"];
  readonly cause?: unknown;

  constructor(message: string, options: { code: string; cause?: unknown }) {
    super(message);
    this.name = "DeterministicRevisionError";
    this.code = options.code as DeterministicRevisionErrorContext["code"];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface DeterministicRevisionDeps {
  readonly detectChanges?: typeof detectGitChanges;
  readonly validatePaths?: typeof validateChangedPaths;
  readonly runCommands?: typeof runRequiredCommands;
}

export interface BuildDeterministicRevisionInput {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly requiredCommands: readonly string[];
  readonly runtime: RequiredCommandRuntimeOptions;
}

function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new DeterministicRevisionError(
      `${fieldName}: debe ser un string.`,
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }

  if (value.trim().length === 0) {
    throw new DeterministicRevisionError(
      `${fieldName}: no puede estar vacío.`,
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }

  return value;
}

function isRevisionPassing(
  pathValidation: PathValidationResult,
  commandsResult: RequiredCommandsExecutionResult | null,
): boolean {
  if (!pathValidation.passed) {
    return false;
  }

  if (commandsResult !== null && !commandsResult.passed) {
    return false;
  }

  return true;
}

export async function buildDeterministicRevision(
  input: BuildDeterministicRevisionInput,
  deps?: DeterministicRevisionDeps,
): Promise<DeterministicRevisionResult> {
  const taskId = validateString(input.taskId, "taskId");
  const projectId = validateString(input.projectId, "projectId");
  const workspaceId = validateString(input.workspaceId, "workspaceId");
  const workspacePath = validateString(input.workspacePath, "workspacePath");
  const baseCommit = validateString(input.baseCommit, "baseCommit");

  const detectChanges = deps?.detectChanges ?? detectGitChanges;
  const validatePaths = deps?.validatePaths ?? validateChangedPaths;
  const runCommands = deps?.runCommands ?? runRequiredCommands;

  const gitResult: GitChangeDetectionResult = detectChanges(workspacePath, baseCommit);

  const pathValidation: PathValidationResult = validatePaths(
    gitResult.changedFiles,
    input.allowedPaths,
    input.forbiddenPaths,
  );

  let commandsResult: RequiredCommandsExecutionResult | null = null;

  if (input.requiredCommands.length > 0) {
    commandsResult = await runCommands(
      workspacePath,
      input.requiredCommands,
      input.runtime,
    );
  }

  const status: RevisionStatus = isRevisionPassing(pathValidation, commandsResult)
    ? "REVIEWING"
    : "REVISION_REQUIRED";

  return {
    taskId,
    projectId,
    workspaceId,
    baseCommit: gitResult.baseCommit,
    changedFiles: gitResult.changedFiles,
    pathValidation,
    commandsResult,
    status,
    generatedAt: new Date().toISOString(),
  };
}
