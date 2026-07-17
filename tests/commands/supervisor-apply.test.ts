import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, initializeSchema } from "../../src/db.js";
import { getTaskById, getTaskContract, updateTaskState } from "../../src/repositories/task-repository.js";
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

function writeJsonFile(directory: string, fileName: string, value: unknown): string {
  const filePath = join(directory, fileName);
  writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

function setupGeneratingTask(taskId: string = "TASK-001") {
  const homeDirectory = createTempDirectory();
  const fixtureDirectory = createTempDirectory();
  const gitRepository = createTempGitRepository();
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
        "Aplicar resultado manual",
      ],
      { home },
    ).exitCode,
  ).toBe(0);
  expect(runCli(["supervisor", "start", "--task", taskId], { home }).exitCode).toBe(0);

  return { homeDirectory, fixtureDirectory, gitRepository, home, taskId };
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

describe("supervisor apply command", () => {
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

  it("applies an EXECUTABLE_TASK result and persists a contract", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const resultPath = writeJsonFile(fixtureDirectory.path, "exec.json", executableResult);

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", resultPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Clasificación: EXECUTABLE_TASK");
    expect(result.stdout).toContain("Estado actual: CONTRACT_APPROVAL_REQUIRED");
    expect(result.stdout).toContain("Contrato persistido: Sí");
    expect(result.stdout).toContain("Tipo de solicitud: CONTRACT_APPROVAL");
    expect(result.stdout.split("\n")).toHaveLength(6);
    expect(result.stdout).not.toContain("reasoning");
    expect(result.stdout).not.toContain("optionsJson");
    expect(result.stdout).not.toContain('{"');
    expectNoisyOrEmptyStderr(result.stderr);

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
      expect(getTaskContract(database, "TASK-001")).not.toBeNull();
      const pending = listPendingHumanRequests(database).filter((request) => request.taskId === "TASK-001");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.type).toBe("CONTRACT_APPROVAL");
    } finally {
      database.close();
    }

    expect(gitRepository.runGit(["status", "--short"])).toBe("");
  });

  it("applies a NEEDS_DECOMPOSITION result", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const resultPath = writeJsonFile(fixtureDirectory.path, "decomp.json", decompositionResult);

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", resultPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Clasificación: NEEDS_DECOMPOSITION");
    expect(result.stdout).toContain("Estado actual: HUMAN_REQUIRED");
    expect(result.stdout).toContain("Contrato persistido: No");
    expect(result.stdout).toContain("Acción requerida: Descomposición humana");

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("HUMAN_REQUIRED");
      expect(getTaskContract(database, "TASK-001")).toBeNull();
      const pending = listPendingHumanRequests(database).filter((request) => request.taskId === "TASK-001");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.type).toBe("FUNCTIONAL_DECISION");
      expect(pending[0]?.question).toContain(decompositionResult.decompositionReason);
    } finally {
      database.close();
    }
  });

  it("applies a NEEDS_DISCOVERY result", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const resultPath = writeJsonFile(fixtureDirectory.path, "discovery.json", discoveryResult);

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", resultPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Clasificación: NEEDS_DISCOVERY");
    expect(result.stdout).toContain("Estado actual: HUMAN_REQUIRED");
    expect(result.stdout).toContain("Contrato persistido: No");
    expect(result.stdout).toContain("Acción requerida: Descubrimiento humano");

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("HUMAN_REQUIRED");
      expect(getTaskContract(database, "TASK-001")).toBeNull();
      const pending = listPendingHumanRequests(database).filter((request) => request.taskId === "TASK-001");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.type).toBe("FUNCTIONAL_DECISION");
      expect(pending[0]?.question).toContain(discoveryResult.missingInformation[0]);
    } finally {
      database.close();
    }
  });

  it("rejects an empty result path", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", "   "], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("La ruta del resultado no puede estar vacía.");
  });

  it("rejects a missing file and preserves task state", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const missingPath = join(fixtureDirectory.path, "missing.json");

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", missingPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`No se pudo leer el resultado del supervisor: ${missingPath}`);

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("GENERATING_CONTRACT");
      expect(listPendingHumanRequests(database)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rejects a directory used as a file", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const dirPath = join(fixtureDirectory.path, "results-dir");
    mkdirSync(dirPath);

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", dirPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`No se pudo leer el resultado del supervisor: ${dirPath}`);
  });

  it("rejects syntactically invalid JSON", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const invalidPath = join(fixtureDirectory.path, "invalid.json");
    writeFileSync(invalidPath, "{ invalid", "utf8");

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", invalidPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`El archivo de resultado no contiene JSON válido: ${invalidPath}`);
  });

  it("rejects structural validation errors", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const invalidPath = writeJsonFile(fixtureDirectory.path, "structural.json", { summary: "missing classification" });

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", invalidPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Resultado del supervisor inválido:");

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("GENERATING_CONTRACT");
      expect(getTaskContract(database, "TASK-001")).toBeNull();
      expect(listPendingHumanRequests(database)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rejects semantic validation errors", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const invalidPath = writeJsonFile(fixtureDirectory.path, "semantic.json", {
      ...executableResult,
      allowedPaths: ["/etc/passwd"],
    });

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", invalidPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Resultado del supervisor semánticamente inválido:");

    const database = openHomeDatabase(home);
    try {
      expect(getTaskById(database, "TASK-001")?.state).toBe("GENERATING_CONTRACT");
      expect(getTaskContract(database, "TASK-001")).toBeNull();
      expect(listPendingHumanRequests(database)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rejects wrong task states", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask());
    const home = homeDirectory.path;
    const resultPath = writeJsonFile(fixtureDirectory.path, "exec.json", executableResult);

    const database = openHomeDatabase(home);
    try {
      expect(updateTaskState(database, "TASK-001", "HUMAN_REQUIRED", new Date().toISOString())?.state).toBe(
        "HUMAN_REQUIRED",
      );
    } finally {
      database.close();
    }

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", resultPath], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "La tarea TASK-001 no puede aplicar un resultado del supervisor desde el estado HUMAN_REQUIRED.",
    );
  });

  it("accepts relative and absolute paths without changing cwd", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask("TASK-001"));
    const home = homeDirectory.path;
    const relativePath = writeJsonFile(fixtureDirectory.path, "relative.json", executableResult);
    const cwd = fixtureDirectory.path;
    const relativeResult = runCli(
      ["supervisor", "apply", "--task", "TASK-001", "--result", "relative.json"],
      { home, cwd },
    );
    expect(relativeResult.exitCode).toBe(0);

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
          "Aplicar por ruta absoluta",
        ],
        { home, cwd },
      ).exitCode,
    ).toBe(0);
    expect(runCli(["supervisor", "start", "--task", "TASK-002"], { home, cwd }).exitCode).toBe(0);

    const absoluteResult = runCli(
      ["supervisor", "apply", "--task", "TASK-002", "--result", resolve(relativePath)],
      { home, cwd },
    );
    expect(absoluteResult.exitCode).toBe(0);
    expect(process.cwd()).not.toBe(cwd);
  });

  it("does not affect another task and persists between processes", () => {
    ({ homeDirectory, fixtureDirectory, gitRepository } = setupGeneratingTask("TASK-001"));
    const home = homeDirectory.path;
    const cwd = fixtureDirectory.path;
    const resultPath = writeJsonFile(fixtureDirectory.path, "discovery.json", discoveryResult);

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
          "No debe cambiar",
        ],
        { home, cwd },
      ).exitCode,
    ).toBe(0);
    expect(runCli(["supervisor", "start", "--task", "TASK-002"], { home, cwd }).exitCode).toBe(0);

    const result = runCli(["supervisor", "apply", "--task", "TASK-001", "--result", resultPath], {
      home,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    const inspectOne = runCli(["inspect", "--task", "TASK-001"], { home, cwd });
    const inspectTwo = runCli(["inspect", "--task", "TASK-002"], { home, cwd });
    expect(inspectOne.stdout).toContain("Estado: HUMAN_REQUIRED");
    expect(inspectTwo.stdout).toContain("Estado: GENERATING_CONTRACT");
    expect(gitRepository.runGit(["status", "--short"])).toBe("");
  });

  it("shows supervisor apply in help", () => {
    homeDirectory = createTempDirectory();
    fixtureDirectory = createTempDirectory();
    const home = homeDirectory.path;

    const helpResult = runCli(["supervisor", "apply", "--help"], {
      home,
      cwd: fixtureDirectory.path,
    });

    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stdout).toContain("--task <task-id>");
    expect(helpResult.stdout).toContain("--result <json-file>");
  });
});
