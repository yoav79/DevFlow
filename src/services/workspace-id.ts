import { DevFlowPathError, validatePathIdentifier } from "./devflow-paths.js";

export interface WorkspaceIdInput {
  projectId: string;
  taskId: string;
  executionNumber: number;
}

export class WorkspaceIdError extends Error {
  readonly field?: string;
  readonly value?: unknown;
  readonly cause?: unknown;

  constructor(
    message: string,
    options?: { field?: string; value?: unknown; cause?: unknown },
  ) {
    super(message);
    this.name = "WorkspaceIdError";
    this.field = options?.field;
    this.value = options?.value;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const EXECUTION_NUMBER_ERROR_MESSAGE = "El número de ejecución debe ser un entero seguro mayor o igual que 1.";

function normalizeIdentifier(field: "projectId" | "taskId", value: string): string {
  try {
    return validatePathIdentifier(field, value);
  } catch (error) {
    if (error instanceof DevFlowPathError) {
      throw new WorkspaceIdError(error.message, {
        field: error.field,
        value: error.value,
        cause: error,
      });
    }

    throw error;
  }
}

function validateExecutionNumber(executionNumber: number): number {
  if (typeof executionNumber !== "number" || !Number.isSafeInteger(executionNumber) || executionNumber < 1) {
    throw new WorkspaceIdError(EXECUTION_NUMBER_ERROR_MESSAGE, {
      field: "executionNumber",
      value: executionNumber,
    });
  }

  return executionNumber;
}

export function buildWorkspaceId(input: WorkspaceIdInput): string {
  const projectId = normalizeIdentifier("projectId", input.projectId);
  const taskId = normalizeIdentifier("taskId", input.taskId);
  const executionNumber = validateExecutionNumber(input.executionNumber);

  return `${projectId}:${taskId}:${executionNumber}`;
}
