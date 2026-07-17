import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, initializeSchema } from "../../src/db.js";
import { getTaskById, getTaskContract, updateTaskState } from "../../src/repositories/task-repository.js";
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

function expectNoisyOrEmptyStderr(stderr: string): void {
  if (stderr.length === 0) {
    expect(stderr).toBe("");
    return;
  }

  expect(stderr).toContain("ExperimentalWarning");
}

function setupPendingContractApproval(taskId: string = "TASK-001") {
  const homeDirectory = createTempDirectory();
  const fixtureDirectory = createTempDirectory();
  const gitRepository = createTempGitRepository();
  const home = homeDirectory.path;
  const cwd = fixtureDirectory.path;

  expect(runCli(["init"], { home, cwd }).exitCode).toBe(0);
  expect(runCli(["project", "add", gitRepository.path, "--id", "alpha", "--name", "Alpha"], { home, cwd }).exitCode).toBe(0);
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
        "Resolver contrato",
      ],
      { home, cwd },
    ).exitCode,
  ).toBe(0);
  expect(runCli(["supervisor", "start", "--task", taskId], { home, cwd }).exitCode).toBe(0);

  const resultPath = writeJsonFile(fixtureDirectory.path, "exec.json", executableResult);
  const applyResult = runCli(["supervisor", "apply", "--task", taskId, "--result", resultPath], { home, cwd });
  expect(applyResult.exitCode).toBe(0);

  const database = openHomeDatabase(home);
  let requestId = "";
  try {
    requestId = listPendingHumanRequests(database).find((request) => request.taskId === taskId)?.id ?? "";
  } finally {
    database.close();
  }

  expect(requestId.length).toBeGreaterThan(0);

  return { homeDirectory, fixtureDirectory, gitRepository, home, cwd, taskId, requestId };
}

describe("contract decide command", () => {
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

  it("applies APPROVE and moves the task to PREPARING_WORKSPACE", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const databaseBefore = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(databaseBefore)[0]?.id ?? "";
    } finally {
      databaseBefore.close();
    }

    const result = runCli(["contract", "decide", "--request", requestId, "--decision", "approve"], { home, cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Decisión contractual aplicada: ${requestId}`);
    expect(result.stdout).toContain("Tarea: TASK-001");
    expect(result.stdout).toContain("Decisión: APPROVE");
    expect(result.stdout).toContain("Estado actual: PREPARING_WORKSPACE");
    expect(result.stdout).toContain("Estado de solicitud: RESOLVED");
    expect(result.stdout.split("\n")).toHaveLength(6);
    expect(result.stdout).not.toContain("resolutionJson");
    expect(result.stdout).not.toContain("contractJson");
    expect(result.stdout).not.toContain("optionsJson");
    expectNoisyOrEmptyStderr(result.stderr);

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("PREPARING_WORKSPACE");
      expect(getTaskContract(database, "TASK-001")).not.toBeNull();
      const request = getHumanRequestById(database, requestId);
      expect(request?.status).toBe("RESOLVED");
      expect(request?.resolutionJson).toBe('{"decision":"APPROVE"}');
    } finally {
      database.close();
    }

    expect(gitRepository.runGit(["status", "--short"])).toBe("");
  });

  it("allows APPROVE with comment but does not print it", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const databaseBefore = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(databaseBefore)[0]?.id ?? "";
    } finally {
      databaseBefore.close();
    }

    const result = runCli(
      ["contract", "decide", "--request", requestId, "--decision", "APPROVE", "--comment", "  listo  "],
      { home, cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("listo");

    const database = openHomeDatabase(home);
    try {
      expect(getHumanRequestById(database, requestId)?.resolutionJson).toBe(
        '{"decision":"APPROVE","comment":"listo"}',
      );
    } finally {
      database.close();
    }
  });

  it("applies REQUEST_CHANGES and moves the task to GENERATING_CONTRACT", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const databaseBefore = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(databaseBefore)[0]?.id ?? "";
    } finally {
      databaseBefore.close();
    }

    const result = runCli(
      ["contract", "decide", "--request", requestId, "--decision", "request_changes", "--comment", "  ajusta alcance  "],
      { home, cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Decisión: REQUEST_CHANGES");
    expect(result.stdout).toContain("Estado actual: GENERATING_CONTRACT");

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("GENERATING_CONTRACT");
      expect(getHumanRequestById(database, requestId)?.status).toBe("RESOLVED");
      expect(getHumanRequestById(database, requestId)?.resolutionJson).toBe(
        '{"decision":"REQUEST_CHANGES","comment":"ajusta alcance"}',
      );
      expect(getTaskContract(database, "TASK-001")).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("requires comment for REQUEST_CHANGES", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const databaseBefore = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(databaseBefore)[0]?.id ?? "";
    } finally {
      databaseBefore.close();
    }

    const result = runCli(["contract", "decide", "--request", requestId, "--decision", "REQUEST_CHANGES"], { home, cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("La decisión REQUEST_CHANGES requiere un comentario.");
  });

  it("applies REJECT and moves the task to BLOCKED", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const databaseBefore = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(databaseBefore)[0]?.id ?? "";
    } finally {
      databaseBefore.close();
    }

    const result = runCli(
      ["contract", "decide", "--request", requestId, "--decision", "REJECT", "--comment", "  no procede  "],
      { home, cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Decisión: REJECT");
    expect(result.stdout).toContain("Estado actual: BLOCKED");
    expect(result.stdout).toContain("Estado de solicitud: REJECTED");

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("BLOCKED");
      expect(getHumanRequestById(database, requestId)?.status).toBe("REJECTED");
      expect(getHumanRequestById(database, requestId)?.resolutionJson).toBe(
        '{"decision":"REJECT","comment":"no procede"}',
      );
      expect(getTaskContract(database, "TASK-001")).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("requires comment for REJECT", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const databaseBefore = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(databaseBefore)[0]?.id ?? "";
    } finally {
      databaseBefore.close();
    }

    const result = runCli(["contract", "decide", "--request", requestId, "--decision", "REJECT", "--comment", "   "], { home, cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("La decisión REJECT requiere un comentario.");
  });

  it("rejects invalid CLI decisions and empty request ids", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const badDecision = runCli(["contract", "decide", "--request", "REQ-1", "--decision", "appr"], { home, cwd });
    expect(badDecision.exitCode).toBe(1);
    expect(badDecision.stdout).toBe("");
    expect(badDecision.stderr).toContain("Decisión de contrato no válida: APPR");

    const emptyRequest = runCli(["contract", "decide", "--request", "   ", "--decision", "APPROVE"], { home, cwd });
    expect(emptyRequest.exitCode).toBe(1);
    expect(emptyRequest.stdout).toBe("");
    expect(emptyRequest.stderr).toContain("El id de la solicitud no puede estar vacío.");
  });

  it("rejects nonexistent, wrong-type and already closed requests", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const missing = runCli(["contract", "decide", "--request", "missing", "--decision", "APPROVE"], { home, cwd });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No existe la solicitud humana: missing");

    const decompPath = writeJsonFile(fixtureDirectory.path, "decomp.json", decompositionResult);
    expect(
      runCli(
        [
          "task",
          "create",
          "--project",
          "alpha",
          "--id",
          "TASK-DEC",
          "--title",
          "Tarea de descomposición",
          "--description",
          "Genera FUNCTIONAL_DECISION",
        ],
        { home, cwd },
      ).exitCode,
    ).toBe(0);
    expect(runCli(["supervisor", "start", "--task", "TASK-DEC"], { home, cwd }).exitCode).toBe(0);
    expect(runCli(["supervisor", "apply", "--task", "TASK-DEC", "--result", decompPath], { home, cwd }).exitCode).toBe(0);

    const database = openHomeDatabase(home);
    let contractRequestId = "";
    let functionalRequestId = "";
    try {
      contractRequestId = listPendingHumanRequests(database).find((request) => request.taskId === "TASK-001")?.id ?? "";
      functionalRequestId = listPendingHumanRequests(database).find((request) => request.taskId === "TASK-DEC")?.id ?? "";
    } finally {
      database.close();
    }

    const wrongType = runCli(["contract", "decide", "--request", functionalRequestId, "--decision", "APPROVE"], { home, cwd });
    expect(wrongType.exitCode).toBe(1);
    expect(wrongType.stderr).toContain(`La solicitud ${functionalRequestId} no es una aprobación de contrato.`);

    expect(runCli(["contract", "decide", "--request", contractRequestId, "--decision", "APPROVE"], { home, cwd }).exitCode).toBe(0);

    const closed = runCli(["contract", "decide", "--request", contractRequestId, "--decision", "APPROVE"], { home, cwd });
    expect(closed.exitCode).toBe(1);
    expect(closed.stderr).toContain(`La solicitud ${contractRequestId} ya está cerrada con estado RESOLVED.`);
  });

  it("rejects if task is no longer in CONTRACT_APPROVAL_REQUIRED", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval());
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const database = openHomeDatabase(home);
    let requestId = "";
    try {
      requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      updateTaskState(database, "TASK-001", "HUMAN_REQUIRED", new Date().toISOString());
    } finally {
      database.close();
    }

    const result = runCli(["contract", "decide", "--request", requestId, "--decision", "APPROVE"], { home, cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "La tarea TASK-001 no puede resolver una aprobación de contrato desde el estado HUMAN_REQUIRED.",
    );
  });

  it("does not affect another task or request and persists across processes", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupPendingContractApproval("TASK-001"));
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    expect(
      runCli(
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
          "Otra aprobación",
        ],
        { home, cwd },
      ).exitCode,
    ).toBe(0);
    expect(runCli(["supervisor", "start", "--task", "TASK-002"], { home, cwd }).exitCode).toBe(0);

    const execPath = writeJsonFile(fixtureDirectory.path, "exec-2.json", executableResult);
    expect(runCli(["supervisor", "apply", "--task", "TASK-002", "--result", execPath], { home, cwd }).exitCode).toBe(0);

    const database = openHomeDatabase(home);
    let requestOne = "";
    let requestTwo = "";
    try {
      requestOne = listPendingHumanRequests(database).find((request) => request.taskId === "TASK-001")?.id ?? "";
      requestTwo = listPendingHumanRequests(database).find((request) => request.taskId === "TASK-002")?.id ?? "";
    } finally {
      database.close();
    }

    const result = runCli(["contract", "decide", "--request", requestOne, "--decision", "APPROVE"], { home, cwd });
    expect(result.exitCode).toBe(0);

    const reopened = openHomeDatabase(home);
    try {
      expect(getTaskById(reopened, "TASK-001")?.state).toBe("PREPARING_WORKSPACE");
      expect(getTaskById(reopened, "TASK-002")?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
      expect(getHumanRequestById(reopened, requestTwo)?.status).toBe("PENDING");
    } finally {
      reopened.close();
    }

    expect(gitRepository.runGit(["status", "--short"])).toBe("");
  });

  it("shows contract decide in help", () => {
    homeDirectory = createTempDirectory();
    fixtureDirectory = createTempDirectory();
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;

    const result = runCli(["contract", "decide", "--help"], { home, cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--request <request-id>");
    expect(result.stdout).toContain("--decision <decision>");
    expect(result.stdout).toContain("--comment <text>");
  });
});
