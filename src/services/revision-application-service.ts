/// <reference types="node" />

import type { DatabaseSync } from "node:sqlite";

import { getProjectById } from "../repositories/project-repository.js";
import {
  getTaskById,
  getTaskContract,
} from "../repositories/task-repository.js";
import { listTaskWorkspacesByTaskId } from "../repositories/task-workspace-repository.js";
import {
  executeDeterministicRevision,
  type BuildDeterministicRevisionInput,
  type DeterministicRevisionResult,
} from "./deterministic-revision-result.js";
import type { RequiredCommandRuntimeOptions } from "./required-command-runner.js";

export interface RevisionApplicationDeps {
  readonly runRevision?: typeof executeDeterministicRevision;
}

export interface ExecuteRevisionForTaskResult {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly result: DeterministicRevisionResult;
}

export class RevisionApplicationError extends Error {
  readonly code:
    | "INVALID_TASK_ID"
    | "TASK_NOT_FOUND"
    | "TASK_NOT_IN_VERIFYING"
    | "NO_WORKSPACE"
    | "NO_CONTRACT"
    | "REVISION_FAILED";

  constructor(
    message: string,
    options: {
      code: RevisionApplicationError["code"];
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "RevisionApplicationError";
    this.code = options.code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function buildRevisionInput(
  database: DatabaseSync,
  taskId: string,
  runtime: RequiredCommandRuntimeOptions,
): {
  taskId: string;
  projectId: string;
  workspaceId: string;
  input: BuildDeterministicRevisionInput;
} {
  const id = taskId.trim();

  if (id.length === 0) {
    throw new RevisionApplicationError(
      "El id de la tarea no puede estar vacío.",
      { code: "INVALID_TASK_ID" },
    );
  }

  const task = getTaskById(database, id);
  if (task === null) {
    throw new RevisionApplicationError(
      `No existe la tarea: ${id}`,
      { code: "TASK_NOT_FOUND" },
    );
  }

  if (task.state !== "VERIFYING") {
    throw new RevisionApplicationError(
      `La tarea ${id} no puede ejecutar la revisión desde el estado ${task.state}. Se esperaba VERIFYING.`,
      { code: "TASK_NOT_IN_VERIFYING" },
    );
  }

  const project = getProjectById(database, task.projectId);
  if (project === null) {
    throw new RevisionApplicationError(
      `No existe el proyecto: ${task.projectId}`,
      { code: "TASK_NOT_FOUND" },
    );
  }

  const contract = getTaskContract(database, id);
  if (contract === null) {
    throw new RevisionApplicationError(
      `La tarea ${id} no tiene un contrato persistido.`,
      { code: "NO_CONTRACT" },
    );
  }

  const workspaces = listTaskWorkspacesByTaskId(database, id);
  const readyWorkspaces = workspaces.filter((w) => w.status === "READY");

  if (readyWorkspaces.length === 0) {
    throw new RevisionApplicationError(
      `La tarea ${id} no tiene un workspace listo para la revisión.`,
      { code: "NO_WORKSPACE" },
    );
  }

  if (readyWorkspaces.length > 1) {
    throw new RevisionApplicationError(
      `La tarea ${id} tiene múltiples workspaces listos: ${readyWorkspaces.length}.`,
      { code: "NO_WORKSPACE" },
    );
  }

  const workspace = readyWorkspaces[0]!;

  return {
    taskId: task.id,
    projectId: project.id,
    workspaceId: workspace.id,
    input: {
      taskId: task.id,
      projectId: project.id,
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      baseCommit: workspace.baseCommit,
      allowedPaths: contract.allowedPaths,
      forbiddenPaths: contract.forbiddenPaths,
      requiredCommands: contract.requiredCommands,
      runtime,
    },
  };
}

export async function executeRevisionForTask(
  database: DatabaseSync,
  taskId: string,
  runtime: RequiredCommandRuntimeOptions,
  deps?: RevisionApplicationDeps,
): Promise<ExecuteRevisionForTaskResult> {
  const { taskId: normalizedTaskId, projectId, workspaceId, input } =
    buildRevisionInput(database, taskId, runtime);

  const runRevision = deps?.runRevision ?? executeDeterministicRevision;

  const result = await runRevision(database, input);

  return {
    taskId: normalizedTaskId,
    projectId,
    workspaceId,
    result,
  };
}
