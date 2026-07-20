/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import { getProjectById } from "../repositories/project-repository.js";
import { getTaskById, getTaskContract, updateTaskState } from "../repositories/task-repository.js";
import { listTaskWorkspacesByTaskId } from "../repositories/task-workspace-repository.js";
import {
  runExecutorWithOpenCode,
  type ExecutorRuntimeOptions,
} from "./executor-opencode-executor.js";
import type { ExecutorPromptInput } from "./executor-prompt-builder.js";
import type { ExecutorOpenCodeInterpretation } from "./executor-opencode-integration.js";

export interface ExecutorApplicationDeps {
  readonly runExecutor?: typeof runExecutorWithOpenCode;
  readonly listWorkspaces?: typeof listTaskWorkspacesByTaskId;
}

export interface ExecuteExecutorForTaskResult {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly branchName: string;
  readonly executionNumber: number;
  readonly interpretation: ExecutorOpenCodeInterpretation;
}

function normalizeTaskId(taskId: string): string {
  return taskId.trim();
}

function buildPromptInput(database: DatabaseSync, taskId: string): {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly promptInput: ExecutorPromptInput;
} {
  const id = normalizeTaskId(taskId);

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const task = getTaskById(database, id);
  if (task === null) {
    throw new Error(`No existe la tarea: ${id}`);
  }

  if (task.state !== "EXECUTING") {
    throw new Error(
      `La tarea ${id} no puede ejecutar el executor desde el estado ${task.state}.`,
    );
  }

  const project = getProjectById(database, task.projectId);
  if (project === null) {
    throw new Error(`No existe el proyecto: ${task.projectId}`);
  }

  const contract = getTaskContract(database, id);
  if (contract === null) {
    throw new Error(`La tarea ${id} no tiene un contrato persistido.`);
  }

  const workspaces = listTaskWorkspacesByTaskId(database, id);
  const readyWorkspaces = workspaces.filter((w) => w.status === "READY");

  if (readyWorkspaces.length === 0) {
    throw new Error(`La tarea ${id} no tiene un workspace listo para ejecutar.`);
  }

  if (readyWorkspaces.length > 1) {
    throw new Error(
      `La tarea ${id} tiene múltiples workspaces listos: ${readyWorkspaces.length}.`,
    );
  }

  const workspace = readyWorkspaces[0];

  if (workspace === undefined) {
    throw new Error(`La tarea ${id} no tiene un workspace listo para ejecutar.`);
  }

  return {
    taskId: task.id,
    projectId: project.id,
    workspaceId: workspace.id,
    promptInput: {
      project: {
        name: project.name,
      },
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
      },
      contract: {
        objective: contract.objective,
        context: contract.context,
        acceptanceCriteria: contract.acceptanceCriteria,
        allowedPaths: contract.allowedPaths,
        forbiddenPaths: contract.forbiddenPaths,
        requiredCommands: contract.requiredCommands,
        assumptions: contract.assumptions,
        risks: contract.risks,
      },
      workspace: {
        workspacePath: workspace.workspacePath,
        branchName: workspace.branchName,
        baseCommit: workspace.baseCommit,
        executionNumber: workspace.executionNumber,
      },
    },
  };
}

export async function executeExecutorForTask(
  database: DatabaseSync,
  taskId: string,
  runtime: ExecutorRuntimeOptions,
  deps?: ExecutorApplicationDeps,
): Promise<ExecuteExecutorForTaskResult> {
  const { taskId: normalizedTaskId, projectId, workspaceId, promptInput } = buildPromptInput(
    database,
    taskId,
  );
  const runExecutor = deps?.runExecutor ?? runExecutorWithOpenCode;
  const interpretation: ExecutorOpenCodeInterpretation = await runExecutor(promptInput, runtime);

  const now = new Date().toISOString();
  const updatedTask = updateTaskState(database, normalizedTaskId, "VERIFYING", now);

  if (updatedTask === null || updatedTask.state !== "VERIFYING") {
    throw new Error(
      `No se pudo pasar la tarea ${normalizedTaskId} al estado VERIFYING.`,
    );
  }

  return {
    taskId: normalizedTaskId,
    projectId,
    workspaceId,
    workspacePath: promptInput.workspace.workspacePath,
    branchName: promptInput.workspace.branchName,
    executionNumber: promptInput.workspace.executionNumber,
    interpretation,
  };
}
