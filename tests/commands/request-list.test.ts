import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, initializeSchema } from "../../src/db.js";
import { getTaskById, updateTaskState } from "../../src/repositories/task-repository.js";
import { getHumanRequestById, listPendingHumanRequests } from "../../src/repositories/human-request-repository.js";
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

function writeJsonFile(directory: string, fileName: string, value: unknown): string {
  const filePath = join(directory, fileName);
  writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

function expectNoisyOrEmptyStderr(stderr: string): void {
  if (stderr.length === 0) {
    expect(stderr).toBe("");
    return;
  }

  expect(stderr).toContain("ExperimentalWarning");
}

const executableResult = {
  classification: "EXECUTABLE_TASK",
  summary: "Add login button",
  reasoning: "Clear scope and bounded changes",
  objective: "Add a login button",
  context: "User management page",
  acceptanceCriteria: ["Button renders", "Click opens modal"],
  allowedPaths: ["src/components"],
  forbiddenPaths: ["src/api"],
  requiredCommands: ["npm run build"],
  assumptions: [],
  risks: [],
  openQuestions: [],
};

const decompositionResult = {
  classification: "NEEDS_DECOMPOSITION",
  summary: "Build auth system",
  reasoning: "Too much surface area",
  decompositionReason: "Auth spans frontend and backend.",
  suggestedTasks: [
    { title: "Add login form", objective: "Implement the login UI" },
    { title: "Add auth API", objective: "Implement the auth endpoint" },
  ],
  openQuestions: ["Which auth provider?"],
};

const discoveryResult = {
  classification: "NEEDS_DISCOVERY",
  summary: "Optimize database",
  reasoning: "Missing performance data",
  missingInformation: ["Current query latency", "Target SLA"],
  recommendedDiscoveryActions: ["Run benchmarks", "Inspect slow queries"],
  openQuestions: ["Which tables are slow?"],
};

function createTaskForProject(home: string, taskId: string, description: string): void {
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
        `Tarea ${taskId}`,
        "--description",
        description,
      ],
      { home },
    ).exitCode,
  ).toBe(0);
}

describe("request list command", () => {
  let homeDirectory: TempDirectory | null = null;
  let fixtureDirectory: TempDirectory | null = null;
  let gitRepository: TempGitRepository | null = null;

  afterEach(() => {
    gitRepository?.cleanup();
    fixtureDirectory?.cleanup();
    homeDirectory?.cleanup();
    gitRepository = null;
    fixtureDirectory = null;
    homeDirectory = null;
  });

  function setupBase(taskId: string = "TASK-001") {
    homeDirectory = createTempDirectory();
    fixtureDirectory = createTempDirectory();
    gitRepository = createTempGitRepository();
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    expect(runCli(["init"], { home, cwd }).exitCode).toBe(0);
    expect(runCli(["project", "add", gitRepository.path, "--id", "alpha", "--name", "Alpha"], { home, cwd }).exitCode).toBe(0);
    createTaskForProject(home, taskId, "Preparar list request");

    return { home, cwd, taskId };
  }

  it("lists zero pending requests for a task without requests", () => {
    const { home, cwd, taskId } = setupBase();

    const result = runCli(["request", "list", "--task", taskId], { home, cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Solicitudes pendientes para ${taskId}: 0`);
    expectNoisyOrEmptyStderr(result.stderr);
  });

  it("shows a CONTRACT_APPROVAL request", () => {
    const { home, cwd, taskId } = setupBase();

    expect(runCli(["supervisor", "start", "--task", taskId], { home, cwd }).exitCode).toBe(0);
    const resultPath = writeJsonFile(fixtureDirectory!.path, "exec.json", executableResult);
    expect(runCli(["supervisor", "apply", "--task", taskId, "--result", resultPath], { home, cwd }).exitCode).toBe(0);

    const result = runCli(["request", "list", "--task", taskId], { home, cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Solicitudes pendientes para ${taskId}: 1`);
    expect(result.stdout).toContain("Tipo: CONTRACT_APPROVAL");
    expect(result.stdout).toContain("Pregunta: Revisa y aprueba el contrato de la tarea TASK-001.");
    expect(result.stdout).toContain("Opciones: APPROVE, REJECT, REQUEST_CHANGES");
    expect(result.stdout).toContain("Creada: ");
    expect(result.stdout).not.toContain("resolutionJson");
    expect(result.stdout).not.toContain("contractJson");
    expect(gitRepository!.runGit(["status", "--short"])).toBe("");
  });

  it("shows FUNCTIONAL_DECISION requests for decomposition and discovery", () => {
    const { home, cwd, taskId } = setupBase();

    expect(runCli(["supervisor", "start", "--task", taskId], { home, cwd }).exitCode).toBe(0);
    const decompPath = writeJsonFile(fixtureDirectory!.path, "decomp.json", decompositionResult);
    expect(runCli(["supervisor", "apply", "--task", taskId, "--result", decompPath], { home, cwd }).exitCode).toBe(0);

    let result = runCli(["request", "list", "--task", taskId], { home, cwd });
    expect(result.stdout).toContain("Tipo: FUNCTIONAL_DECISION");
    expect(result.stdout).toContain("Opciones: ACCEPT_DECOMPOSITION, EDIT_DECOMPOSITION, CANCEL_TASK");

    const db = openHomeDatabase(home);
    try {
      const requestId = listPendingHumanRequests(db)[0]?.id ?? "";
      db.prepare("UPDATE human_requests SET status = 'RESOLVED', resolutionJson = ?, resolvedAt = ? WHERE id = ?")
        .run('{"decision":"ACCEPT_DECOMPOSITION"}', new Date().toISOString(), requestId);
      updateTaskState(db, taskId, "GENERATING_CONTRACT", new Date().toISOString());
    } finally {
      db.close();
    }

    const discoveryPath = writeJsonFile(fixtureDirectory!.path, "discovery.json", discoveryResult);
    expect(runCli(["supervisor", "apply", "--task", taskId, "--result", discoveryPath], { home, cwd }).exitCode).toBe(0);

    result = runCli(["request", "list", "--task", taskId], { home, cwd });
    expect(result.stdout).toContain("Tipo: FUNCTIONAL_DECISION");
    expect(result.stdout).toContain("Opciones: PROVIDE_INFORMATION, RUN_DISCOVERY, CANCEL_TASK");
    expect(result.stdout).not.toContain("ACCEPT_DECOMPOSITION");
  });

  it("filters by task and excludes resolved or rejected requests", () => {
    const { home, cwd } = setupBase("TASK-001");
    createTaskForProject(home, "TASK-002", "Otra tarea");

    expect(runCli(["supervisor", "start", "--task", "TASK-001"], { home, cwd }).exitCode).toBe(0);
    expect(runCli(["supervisor", "start", "--task", "TASK-002"], { home, cwd }).exitCode).toBe(0);

    const execPath = writeJsonFile(fixtureDirectory!.path, "exec.json", executableResult);
    const discoveryPath = writeJsonFile(fixtureDirectory!.path, "discovery.json", discoveryResult);
    expect(runCli(["supervisor", "apply", "--task", "TASK-001", "--result", execPath], { home, cwd }).exitCode).toBe(0);
    expect(runCli(["supervisor", "apply", "--task", "TASK-002", "--result", discoveryPath], { home, cwd }).exitCode).toBe(0);

    const database = openHomeDatabase(home);
    try {
      const taskTwoRequestId = listPendingHumanRequests(database).find((request) => request.taskId === "TASK-002")?.id ?? "";
      database
        .prepare("UPDATE human_requests SET status = 'RESOLVED', resolutionJson = ?, resolvedAt = ? WHERE id = ?")
        .run('{"decision":"PROVIDE_INFORMATION"}', new Date().toISOString(), taskTwoRequestId);
    } finally {
      database.close();
    }

    const result = runCli(["request", "list", "--task", "TASK-001"], { home, cwd });

    expect(result.stdout).toContain("Solicitudes pendientes para TASK-001: 1");
    expect(result.stdout).not.toContain("TASK-002");
  });

  it("orders multiple pending requests by createdAt and id", () => {
    const { home, cwd, taskId } = setupBase();
    const database = openHomeDatabase(home);

    try {
      database.prepare(
        "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "REQ-B",
        taskId,
        "FUNCTIONAL_DECISION",
        "Pregunta B",
        JSON.stringify(["B"]),
        null,
        "PENDING",
        "2024-01-01T00:00:00.000Z",
        null,
      );
      database.prepare(
        "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "REQ-A",
        taskId,
        "FUNCTIONAL_DECISION",
        "Pregunta A",
        JSON.stringify(["A"]),
        null,
        "PENDING",
        "2024-01-01T00:00:00.000Z",
        null,
      );
    } finally {
      database.close();
    }

    const result = runCli(["request", "list", "--task", taskId], { home, cwd });
    const reqAIndex = result.stdout.indexOf("ID: REQ-A");
    const reqBIndex = result.stdout.indexOf("ID: REQ-B");

    expect(reqAIndex).toBeGreaterThan(-1);
    expect(reqBIndex).toBeGreaterThan(-1);
    expect(reqAIndex).toBeLessThan(reqBIndex);
    expect(result.stdout).toContain("\n\nID: REQ-B");
  });

  it("rejects invalid task ids and invalid optionsJson", () => {
    const { home, cwd, taskId } = setupBase();

    let result = runCli(["request", "list", "--task", "   "], { home, cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("El id de la tarea no puede estar vacío.");

    result = runCli(["request", "list", "--task", "missing"], { home, cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No existe la tarea: missing");

    const database = openHomeDatabase(home);
    try {
      database.prepare(
        "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "REQ-BAD-JSON",
        taskId,
        "FUNCTIONAL_DECISION",
        "Pregunta mala",
        "{bad",
        null,
        "PENDING",
        "2024-01-01T00:00:00.000Z",
        null,
      );
    } finally {
      database.close();
    }

    result = runCli(["request", "list", "--task", taskId], { home, cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("La solicitud REQ-BAD-JSON contiene opciones inválidas.");
  });

  it("rejects non-array optionsJson and arrays with non-string items without modifying data", () => {
    const { home, cwd, taskId } = setupBase();
    const database = openHomeDatabase(home);

    try {
      database.prepare(
        "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "REQ-NOT-ARRAY",
        taskId,
        "FUNCTIONAL_DECISION",
        "Pregunta array",
        JSON.stringify({ option: "A" }),
        null,
        "PENDING",
        "2024-01-01T00:00:00.000Z",
        null,
      );
    } finally {
      database.close();
    }

    let result = runCli(["request", "list", "--task", taskId], { home, cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("La solicitud REQ-NOT-ARRAY contiene opciones inválidas.");

    const reopened = openHomeDatabase(home);
    try {
      reopened.prepare("DELETE FROM human_requests WHERE id = ?").run("REQ-NOT-ARRAY");
      reopened.prepare(
        "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "REQ-NOT-STRING",
        taskId,
        "FUNCTIONAL_DECISION",
        "Pregunta item",
        JSON.stringify(["A", 2]),
        null,
        "PENDING",
        "2024-01-01T00:00:00.000Z",
        null,
      );

      const updatedAt = getTaskById(reopened, taskId)?.updatedAt;
      const resolvedAt = getHumanRequestById(reopened, "REQ-NOT-STRING")?.resolvedAt;

      result = runCli(["request", "list", "--task", taskId], { home, cwd });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("La solicitud REQ-NOT-STRING contiene opciones inválidas.");

      const afterTask = getTaskById(reopened, taskId);
      const afterRequest = getHumanRequestById(reopened, "REQ-NOT-STRING");
      expect(afterTask?.updatedAt).toBe(updatedAt);
      expect(afterRequest?.resolvedAt).toBe(resolvedAt ?? null);
    } finally {
      reopened.close();
    }

    expect(gitRepository!.runGit(["status", "--short"])).toBe("");
  });

  it("persists consistent output across processes and appears in help", () => {
    const { home, cwd, taskId } = setupBase();
    expect(runCli(["supervisor", "start", "--task", taskId], { home, cwd }).exitCode).toBe(0);
    const execPath = writeJsonFile(fixtureDirectory!.path, "exec.json", executableResult);
    expect(runCli(["supervisor", "apply", "--task", taskId, "--result", execPath], { home, cwd }).exitCode).toBe(0);

    const first = runCli(["request", "list", "--task", taskId], { home, cwd });
    const second = runCli(["request", "list", "--task", taskId], { home, cwd });

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.split("\n")[0]).toBe(`Solicitudes pendientes para ${taskId}: 1`);

    const help = runCli(["request", "list", "--help"], { home, cwd });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--task <task-id>");
  });
});
