/// <reference types="node" />

import { DevFlowPathError, validatePathIdentifier } from "./devflow-paths.js";

export interface BranchNameInput {
  projectId: string;
  taskId: string;
  executionNumber: number;
}

export class BranchNameError extends Error {
  readonly field?: string;
  readonly value?: unknown;

  constructor(
    message: string,
    options?: { field?: string; value?: unknown; cause?: unknown },
  ) {
    super(message);
    this.name = "BranchNameError";
    this.field = options?.field;
    this.value = options?.value;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const MAX_BRANCH_LENGTH = 240;

function validateExecutionNumber(executionNumber: number): number {
  if (!Number.isFinite(executionNumber) || !Number.isInteger(executionNumber) || executionNumber < 1) {
    throw new BranchNameError(
      "El número de ejecución debe ser un entero mayor o igual que 1.",
      { field: "executionNumber", value: executionNumber },
    );
  }
  return executionNumber;
}

function validateGitRef(branchName: string): void {
  if (branchName.length > MAX_BRANCH_LENGTH) {
    throw new BranchNameError(
      `El nombre de rama no puede superar ${MAX_BRANCH_LENGTH} caracteres.`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.startsWith("/")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.endsWith("/")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.endsWith(".")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.endsWith(".lock")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.includes("..")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.includes("@{")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (branchName.includes("//")) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (/\s/.test(branchName)) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (/[\x00-\x1f\x7f]/.test(branchName)) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  if (/[~^:?*\[\\]/.test(branchName)) {
    throw new BranchNameError(
      `El nombre de rama generado no es válido: ${branchName}`,
      { field: "branchName", value: branchName },
    );
  }

  const sections = branchName.split("/");
  for (const section of sections) {
    if (section.length === 0) {
      throw new BranchNameError(
        `El nombre de rama generado no es válido: ${branchName}`,
        { field: "branchName", value: branchName },
      );
    }
  }
}

export function buildBranchName(input: BranchNameInput): string {
  let projectId: string;

  try {
    projectId = validatePathIdentifier("projectId", input.projectId);
  } catch (error) {
    if (error instanceof DevFlowPathError) {
      throw new BranchNameError(error.message, {
        field: error.field,
        value: error.value,
        cause: error,
      });
    }
    throw error;
  }

  let taskId: string;

  try {
    taskId = validatePathIdentifier("taskId", input.taskId);
  } catch (error) {
    if (error instanceof DevFlowPathError) {
      throw new BranchNameError(error.message, {
        field: error.field,
        value: error.value,
        cause: error,
      });
    }
    throw error;
  }

  const executionNumber = validateExecutionNumber(input.executionNumber);

  const branchName = `devflow/${projectId}/${taskId}/execution-${executionNumber}`;

  validateGitRef(branchName);

  return branchName;
}
