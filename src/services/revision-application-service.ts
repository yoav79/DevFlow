/// <reference types="node" />

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getProjectById } from "../repositories/project-repository.js";
import {
  claimTaskDeterministicRevision,
  finalizeTaskDeterministicRevision,
  getTaskById,
  getTaskContract,
  type DeterministicRevisionFinalState,
} from "../repositories/task-repository.js";
import { listTaskWorkspacesByTaskId } from "../repositories/task-workspace-repository.js";
import {
  buildDeterministicRevision,
  type BuildDeterministicRevisionInput,
  type DeterministicRevisionResult,
} from "./deterministic-revision-result.js";
import type { RequiredCommandRuntimeOptions } from "./required-command-runner.js";

export interface RevisionApplicationDeps {
  readonly beforeRevalidate?: () => void | Promise<void>;
  readonly buildRevision?: typeof buildDeterministicRevision;
  readonly createClaimId?: () => string;
  readonly now?: () => string;
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
    | "REVISION_PERSIST_FAILED"
    | "REVISION_FAILED"
    | "REVISION_ALREADY_RUNNING"
    | "REVISION_CONCURRENTLY_CHANGED";

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

function requireTask(
  database: DatabaseSync,
  taskId: string,
): NonNullable<ReturnType<typeof getTaskById>> {
  const task = getTaskById(database, taskId);
  if (task === null) {
    throw new RevisionApplicationError(
      `No existe la tarea: ${taskId}`,
      { code: "TASK_NOT_FOUND" },
    );
  }

  return task;
}

function assertTaskIsVerifying(
  task: ReturnType<typeof getTaskById>,
  taskId: string,
): void {
  if (task === null) {
    throw new RevisionApplicationError(
      `No existe la tarea: ${taskId}`,
      { code: "TASK_NOT_FOUND" },
    );
  }

  if (task.state !== "VERIFYING") {
    throw new RevisionApplicationError(
      `La tarea ${taskId} no puede ejecutar la revisión desde el estado ${task.state}. Se esperaba VERIFYING.`,
      { code: "TASK_NOT_IN_VERIFYING" },
    );
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

  const task = requireTask(database, id);
  assertTaskIsVerifying(task, id);

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

  const taskBeforeHook = requireTask(database, normalizedTaskId);
  const expectedCurrentRevisionJson = taskBeforeHook.currentRevisionJson;

  await deps?.beforeRevalidate?.();

  const latestTask = requireTask(database, normalizedTaskId);
  assertTaskIsVerifying(latestTask, normalizedTaskId);

  const createClaimId = deps?.createClaimId ?? (() => randomUUID());
  const nowFn = deps?.now ?? (() => new Date().toISOString());

  const claimJson = JSON.stringify({
    kind: "DETERMINISTIC_REVISION_CLAIM" as const,
    claimId: createClaimId(),
    taskId: normalizedTaskId,
    claimedAt: nowFn(),
  });

  const claimed = claimTaskDeterministicRevision(
    database,
    normalizedTaskId,
    expectedCurrentRevisionJson,
    claimJson,
    nowFn(),
  );

  if (!claimed) {
    throw new RevisionApplicationError(
      `No se pudo adquirir ownership de la revisión para la tarea ${normalizedTaskId}.`,
      { code: "REVISION_ALREADY_RUNNING" },
    );
  }

  const buildRevision = deps?.buildRevision ?? buildDeterministicRevision;

  const result = await buildRevision(input);

  let finalRevisionJson: string;

  try {
    finalRevisionJson = JSON.stringify(result);
  } catch (error) {
    throw new RevisionApplicationError(
      "No se pudo serializar el resultado de revisión.",
      { code: "REVISION_PERSIST_FAILED", cause: error },
    );
  }

  const nextState: DeterministicRevisionFinalState =
    result.status === "REVISION_REQUIRED" ? "REVISION_REQUIRED" : "REVIEWING";

  const finalized = finalizeTaskDeterministicRevision(
    database,
    normalizedTaskId,
    claimJson,
    finalRevisionJson,
    nextState,
    nowFn(),
  );

  if (!finalized) {
    throw new RevisionApplicationError(
      `Ownership de revisión perdido o estado cambiado concurrentemente para la tarea ${normalizedTaskId}.`,
      { code: "REVISION_CONCURRENTLY_CHANGED" },
    );
  }

  return {
    taskId: normalizedTaskId,
    projectId,
    workspaceId,
    result,
  };
}
