import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, initializeSchema } from "../../src/db.js";
import { getTaskById, updateTaskState } from "../../src/repositories/task-repository.js";
import { getProjectById } from "../../src/repositories/project-repository.js";
import { listPendingHumanRequests } from "../../src/repositories/human-request-repository.js";
import { runCli } from "../helpers/cli-runner.js";
import { createTempDirectory, type TempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository, type TempGitRepository } from "../helpers/temp-git-repository.js";

function getDatabasePath(home: string): string {
  return join(home, ".devflow", "devflow.db");
}

function openHomeDatabase(home: string) {
  const database = openDatabase(getDatabasePath(home));
  initializeSchema(database);
  return database;
}

function expectNoisyStderr(stderr: string): void {
  if (stderr.length === 0) {
    expect(stderr).toBe("");
    return;
  }

  expect(stderr).toContain("ExperimentalWarning");
}

describe("supervisor start command", () => {
  let homeDirectory: TempDirectory | null = null;
  let gitRepository: TempGitRepository | null = null;

  afterEach(() => {
    gitRepository?.cleanup();
    homeDirectory?.cleanup();
    gitRepository = null;
    homeDirectory = null;
  });

  function setupCreatedTask(taskId: string = "TASK-001") {
    homeDirectory = createTempDirectory();
    gitRepository = createTempGitRepository();

    const home = homeDirectory.path;

    expect(runCli(["init"], { home }).exitCode).toBe(0);
    expect(
      runCli(["project", "add", gitRepository.path, "--id", "alpha", "--name", "Alpha"], { home }).exitCode,
    ).toBe(0);
    expect(
      runCli(
        [
          "task",
          "create",
          "--project",
          "alpha",
          "--id",
          taskId,
          "--title",
          "Primera tarea",
          "--description",
          "Validar inicio del supervisor",
        ],
        { home },
      ).exitCode,
    ).toBe(0);

    return { home, taskId, repositoryPath: gitRepository.path };
  }

  it("changes a task from CREATED to GENERATING_CONTRACT", () => {
    const { home, taskId } = setupCreatedTask();

    const result = runCli(["supervisor", "start", "--task", taskId], { home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `Supervisor iniciado: ${taskId}\nEstado anterior: CREATED\nEstado actual: GENERATING_CONTRACT`,
    );
    expectNoisyStderr(result.stderr);

    const inspectResult = runCli(["inspect", "--task", taskId], { home });
    expect(inspectResult.stdout).toContain("Estado: GENERATING_CONTRACT");

    const statusResult = runCli(["status", "--project", "alpha"], { home });
    expect(statusResult.stdout).toContain("Tareas activas: 1");
    expect(statusResult.stdout).toContain("GENERATING_CONTRACT: 1");

    const database = openHomeDatabase(home);

    try {
      const task = getTaskById(database, taskId);
      expect(task?.contractJson).toBeNull();
      expect(task?.currentRevisionJson).toBeNull();
      expect(task?.attempt).toBe(0);
      expect(task?.maxAttempts).toBe(2);
      expect(listPendingHumanRequests(database)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("is idempotent when the task is already in GENERATING_CONTRACT", () => {
    const { home, taskId } = setupCreatedTask();

    const first = runCli(["supervisor", "start", "--task", taskId], { home });
    expect(first.exitCode).toBe(0);

    const database = openHomeDatabase(home);
    let previousUpdatedAt = "";

    try {
      previousUpdatedAt = getTaskById(database, taskId)?.updatedAt ?? "";
    } finally {
      database.close();
    }

    const second = runCli(["supervisor", "start", "--task", taskId], { home });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(
      `Supervisor iniciado: ${taskId}\nEstado anterior: GENERATING_CONTRACT\nEstado actual: GENERATING_CONTRACT`,
    );
    expectNoisyStderr(second.stderr);

    const reopened = openHomeDatabase(home);

    try {
      expect(getTaskById(reopened, taskId)?.updatedAt).toBe(previousUpdatedAt);
      expect(listPendingHumanRequests(reopened)).toHaveLength(0);
    } finally {
      reopened.close();
    }
  });

  it("rejects an empty task id", () => {
    const { home } = setupCreatedTask();

    const result = runCli(["supervisor", "start", "--task", "   "], { home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("El id de la tarea no puede estar vacío.");
  });

  it("rejects a nonexistent task", () => {
    const { home } = setupCreatedTask();

    const result = runCli(["supervisor", "start", "--task", "TASK-404"], { home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No existe la tarea: TASK-404");
  });

  it("rejects CONTRACT_APPROVAL_REQUIRED", () => {
    const { home, taskId } = setupCreatedTask();
    const database = openHomeDatabase(home);

    try {
      updateTaskState(database, taskId, "CONTRACT_APPROVAL_REQUIRED", new Date().toISOString());
    } finally {
      database.close();
    }

    const result = runCli(["supervisor", "start", "--task", taskId], { home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `La tarea ${taskId} no puede iniciar el supervisor desde el estado CONTRACT_APPROVAL_REQUIRED.`,
    );
  });

  it("rejects HUMAN_REQUIRED", () => {
    const { home, taskId } = setupCreatedTask();
    const database = openHomeDatabase(home);

    try {
      updateTaskState(database, taskId, "HUMAN_REQUIRED", new Date().toISOString());
    } finally {
      database.close();
    }

    const result = runCli(["supervisor", "start", "--task", taskId], { home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `La tarea ${taskId} no puede iniciar el supervisor desde el estado HUMAN_REQUIRED.`,
    );
  });

  it("rejects PREPARING_WORKSPACE", () => {
    const { home, taskId } = setupCreatedTask();
    const database = openHomeDatabase(home);

    try {
      updateTaskState(database, taskId, "PREPARING_WORKSPACE", new Date().toISOString());
    } finally {
      database.close();
    }

    const result = runCli(["supervisor", "start", "--task", taskId], { home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `La tarea ${taskId} no puede iniciar el supervisor desde el estado PREPARING_WORKSPACE.`,
    );
  });

  it("rejects COMPLETED", () => {
    const { home, taskId } = setupCreatedTask();
    const database = openHomeDatabase(home);

    try {
      updateTaskState(database, taskId, "COMPLETED", new Date().toISOString());
    } finally {
      database.close();
    }

    const result = runCli(["supervisor", "start", "--task", taskId], { home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `La tarea ${taskId} no puede iniciar el supervisor desde el estado COMPLETED.`,
    );
  });

  it("does not modify another task or the registered project", () => {
    const { home, taskId, repositoryPath } = setupCreatedTask("TASK-001");

    const secondCreate = runCli(
      [
        "task",
        "create",
        "--project",
        "alpha",
        "--id",
        "TASK-002",
        "--title",
        "Segunda tarea",
        "--description",
        "No debe cambiar",
      ],
      { home },
    );
    expect(secondCreate.exitCode).toBe(0);

    const result = runCli(["supervisor", "start", "--task", taskId], { home });
    expect(result.exitCode).toBe(0);

    const database = openHomeDatabase(home);

    try {
      expect(getTaskById(database, "TASK-002")?.state).toBe("CREATED");
      expect(getProjectById(database, "alpha")?.repositoryPath).toBe(repositoryPath);
    } finally {
      database.close();
    }

    expect(gitRepository?.runGit(["status", "--short"])).toBe("");
  });

  it("persists state across CLI processes", () => {
    const { home, taskId } = setupCreatedTask();

    expect(runCli(["supervisor", "start", "--task", taskId], { home }).exitCode).toBe(0);

    const inspectResult = runCli(["inspect", "--task", taskId], { home });
    expect(inspectResult.exitCode).toBe(0);
    expect(inspectResult.stdout).toContain("Estado: GENERATING_CONTRACT");
  });

  it("shows the supervisor command in CLI help", () => {
    homeDirectory = createTempDirectory();
    const home = homeDirectory.path;

    const helpResult = runCli(["supervisor", "start", "--help"], { home });

    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stdout).toContain("start");
    expect(helpResult.stdout).toContain("--task <task-id>");
  });
});
