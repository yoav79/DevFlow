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

function setupBase(taskId: string) {
  const homeDirectory = createTempDirectory();
  const fixtureDirectory = createTempDirectory();
  const gitRepository = createTempGitRepository();
  const home = homeDirectory.path;
  const cwd = fixtureDirectory.path;

  expect(runCli(["init"], { home, cwd }).exitCode).toBe(0);
  expect(runCli(["project", "add", gitRepository.path, "--id", "alpha", "--name", "Alpha"], { home, cwd }).exitCode).toBe(0);
  expect(
    runCli(
      ["task", "create", "--project", "alpha", "--id", taskId, "--title", `Tarea ${taskId}`, "--description", "Test"],
      { home, cwd },
    ).exitCode,
  ).toBe(0);
  expect(runCli(["supervisor", "start", "--task", taskId], { home, cwd }).exitCode).toBe(0);

  return { homeDirectory, fixtureDirectory, gitRepository, home, cwd };
}

function setupDecompositionRequest(taskId: string = "TASK-DEC") {
  const { homeDirectory, fixtureDirectory, gitRepository, home, cwd } = setupBase(taskId);

  const decompPath = writeJsonFile(fixtureDirectory.path, "decomp.json", decompositionResult);
  expect(runCli(["supervisor", "apply", "--task", taskId, "--result", decompPath], { home, cwd }).exitCode).toBe(0);

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

function setupDiscoveryRequest(taskId: string = "TASK-DIS") {
  const { homeDirectory, fixtureDirectory, gitRepository, home, cwd } = setupBase(taskId);

  const discoveryPath = writeJsonFile(fixtureDirectory.path, "discovery.json", discoveryResult);
  expect(runCli(["supervisor", "apply", "--task", taskId, "--result", discoveryPath], { home, cwd }).exitCode).toBe(0);

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

describe("request decide command", () => {
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

  describe("EDIT_DECOMPOSITION", () => {
    it("resolves a decomposition request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", homeDirectory.path, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );
      void result;
    });

    it("resolves a decomposition request and exits 0", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify scope"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("changes the task to GENERATING_CONTRACT", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getTaskById(db, "TASK-DEC")?.state).toBe("GENERATING_CONTRACT");
      } finally {
        db.close();
      }
    });

    it("changes the request to RESOLVED", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getHumanRequestById(db, requestId)?.status).toBe("RESOLVED");
      } finally {
        db.close();
      }
    });

    it("stores origin DECOMPOSITION", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.origin).toBe("DECOMPOSITION");
      } finally {
        db.close();
      }
    });

    it("stores decision EDIT_DECOMPOSITION", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.decision).toBe("EDIT_DECOMPOSITION");
      } finally {
        db.close();
      }
    });

    it("stores normalized comment", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "  Simplify  "],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.comment).toBe("Simplify");
      } finally {
        db.close();
      }
    });

    it("rejects if comment is missing", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("La decisión EDIT_DECOMPOSITION requiere un comentario.");
    });

    it("rejects whitespace-only comment", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "   "],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("La decisión EDIT_DECOMPOSITION requiere un comentario.");
    });

    it("rejects the decision over a discovery request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no es compatible con el origen DISCOVERY");
    });

    it("stdout shows DECOMPOSITION and GENERATING_CONTRACT", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout).toContain("Origen: DECOMPOSITION");
      expect(result.stdout).toContain("Estado actual: GENERATING_CONTRACT");
    });
  });

  describe("PROVIDE_INFORMATION", () => {
    it("resolves a discovery request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Latency is 200ms"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("changes the task to GENERATING_CONTRACT", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Latency is 200ms"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getTaskById(db, "TASK-DIS")?.state).toBe("GENERATING_CONTRACT");
      } finally {
        db.close();
      }
    });

    it("changes the request to RESOLVED", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Latency is 200ms"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getHumanRequestById(db, requestId)?.status).toBe("RESOLVED");
      } finally {
        db.close();
      }
    });

    it("stores origin DISCOVERY", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Latency is 200ms"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.origin).toBe("DISCOVERY");
      } finally {
        db.close();
      }
    });

    it("stores decision PROVIDE_INFORMATION", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Latency is 200ms"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.decision).toBe("PROVIDE_INFORMATION");
      } finally {
        db.close();
      }
    });

    it("stores normalized information", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "  Latency 200ms  "],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.comment).toBe("Latency 200ms");
      } finally {
        db.close();
      }
    });

    it("rejects if comment is missing", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("La decisión PROVIDE_INFORMATION requiere información.");
    });

    it("rejects whitespace-only comment", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "   "],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("La decisión PROVIDE_INFORMATION requiere información.");
    });

    it("rejects the decision over a decomposition request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Info"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no es compatible con el origen DECOMPOSITION");
    });

    it("stdout shows DISCOVERY and GENERATING_CONTRACT", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "PROVIDE_INFORMATION", "--comment", "Latency is 200ms"],
        { home, cwd },
      );

      expect(result.stdout).toContain("Origen: DISCOVERY");
      expect(result.stdout).toContain("Estado actual: GENERATING_CONTRACT");
    });
  });

  describe("CANCEL_TASK", () => {
    it("cancels a decomposition request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("cancels a discovery request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("changes the task to CANCELLED", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getTaskById(db, "TASK-DEC")?.state).toBe("CANCELLED");
      } finally {
        db.close();
      }
    });

    it("changes the request to RESOLVED", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getHumanRequestById(db, requestId)?.status).toBe("RESOLVED");
      } finally {
        db.close();
      }
    });

    it("allows comment absent", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("allows comment present", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK", "--comment", "No longer needed"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("stores the inferred origin correctly", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        const resolution = JSON.parse(getHumanRequestById(db, requestId)?.resolutionJson ?? "{}") as Record<string, unknown>;
        expect(resolution.origin).toBe("DECOMPOSITION");
      } finally {
        db.close();
      }
    });

    it("stdout shows CANCEL_TASK and CANCELLED", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.stdout).toContain("Decisión: CANCEL_TASK");
      expect(result.stdout).toContain("Estado actual: CANCELLED");
    });
  });

  describe("CLI validation", () => {
    it("rejects empty requestId", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "   ", "--decision", "CANCEL_TASK"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("El id de la solicitud no puede estar vacío.");
      homeDirectory.cleanup();
    });

    it("rejects unknown decision", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "REQ-1", "--decision", "UNKNOWN"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Decisión funcional no válida: UNKNOWN");
      homeDirectory.cleanup();
    });

    it("rejects ACCEPT_DECOMPOSITION", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "REQ-1", "--decision", "ACCEPT_DECOMPOSITION"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Decisión funcional no válida: ACCEPT_DECOMPOSITION");
      homeDirectory.cleanup();
    });

    it("rejects RUN_DISCOVERY", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "REQ-1", "--decision", "RUN_DISCOVERY"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Decisión funcional no válida: RUN_DISCOVERY");
      homeDirectory.cleanup();
    });

    it("rejects abbreviations", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "REQ-1", "--decision", "EDIT"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Decisión funcional no válida: EDIT");
      homeDirectory.cleanup();
    });

    it("accepts edit_decomposition in lowercase", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "edit_decomposition", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("accepts provide_information in lowercase", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDiscoveryRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "provide_information", "--comment", "Info"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("accepts cancel_task in lowercase", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "cancel_task"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
    });

    it("errors end with exitCode 1", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "missing", "--decision", "CANCEL_TASK"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      homeDirectory.cleanup();
    });

    it("stdout is empty on errors", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "missing", "--decision", "CANCEL_TASK"],
        { home },
      );

      expect(result.stdout).toBe("");
      homeDirectory.cleanup();
    });

    it("stderr contains only the error message", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "missing", "--decision", "CANCEL_TASK"],
        { home },
      );

      expect(result.stderr).toContain("No existe la solicitud humana: missing");
      homeDirectory.cleanup();
    });
  });

  describe("invalid requests", () => {
    it("rejects nonexistent request", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(
        ["request", "decide", "--request", "missing", "--decision", "CANCEL_TASK"],
        { home },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No existe la solicitud humana: missing");
      homeDirectory.cleanup();
    });

    it("rejects CONTRACT_APPROVAL request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        const requests = listPendingHumanRequests(database);
        const contractRequest = requests[0];
        if (contractRequest) {
          database.prepare("UPDATE human_requests SET type = 'CONTRACT_APPROVAL' WHERE id = ?").run(contractRequest.id);
          requestId = contractRequest.id;
        }
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no es una decisión funcional");
    });

    it("rejects RESOLVED request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
        database
          .prepare("UPDATE human_requests SET status = 'RESOLVED', resolutionJson = '{}', resolvedAt = ? WHERE id = ?")
          .run(new Date().toISOString(), requestId);
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ya está cerrada con estado RESOLVED");
    });

    it("rejects REJECTED request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
        database
          .prepare("UPDATE human_requests SET status = 'REJECTED', resolvedAt = ? WHERE id = ?")
          .run(new Date().toISOString(), requestId);
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ya está cerrada con estado REJECTED");
    });

    it("rejects task outside HUMAN_REQUIRED", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
        updateTaskState(database, "TASK-DEC", "GENERATING_CONTRACT", new Date().toISOString());
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no puede resolver una decisión funcional desde el estado GENERATING_CONTRACT");
    });

    it("rejects invalid optionsJson", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
        database.prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?").run("not-json", requestId);
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No se puede determinar el origen");
    });
  });

  describe("isolation and persistence", () => {
    it("resolving one request does not affect another task", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest("TASK-1"));
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      expect(
        runCli(
          ["task", "create", "--project", "alpha", "--id", "TASK-2", "--title", "Other", "--description", "Other"],
          { home, cwd },
        ).exitCode,
      ).toBe(0);
      expect(runCli(["supervisor", "start", "--task", "TASK-2"], { home, cwd }).exitCode).toBe(0);
      const decompPath = writeJsonFile(fixtureDirectory.path, "decomp2.json", decompositionResult);
      expect(runCli(["supervisor", "apply", "--task", "TASK-2", "--result", decompPath], { home, cwd }).exitCode).toBe(0);

      const database = openHomeDatabase(home);
      let request1 = "";
      let request2 = "";
      try {
        const all = listPendingHumanRequests(database);
        request1 = all.find((r) => r.taskId === "TASK-1")?.id ?? "";
        request2 = all.find((r) => r.taskId === "TASK-2")?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", request1, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getTaskById(db, "TASK-2")?.state).toBe("HUMAN_REQUIRED");
        expect(getHumanRequestById(db, request2)?.status).toBe("PENDING");
      } finally {
        db.close();
      }
    });

    it("resolving one request does not affect another HumanRequest", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest("TASK-1"));
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      expect(
        runCli(
          ["task", "create", "--project", "alpha", "--id", "TASK-2", "--title", "Other", "--description", "Other"],
          { home, cwd },
        ).exitCode,
      ).toBe(0);
      expect(runCli(["supervisor", "start", "--task", "TASK-2"], { home, cwd }).exitCode).toBe(0);
      const decompPath = writeJsonFile(fixtureDirectory.path, "decomp2.json", decompositionResult);
      expect(runCli(["supervisor", "apply", "--task", "TASK-2", "--result", decompPath], { home, cwd }).exitCode).toBe(0);

      const database = openHomeDatabase(home);
      let request1 = "";
      let request2 = "";
      try {
        const all = listPendingHumanRequests(database);
        request1 = all.find((r) => r.taskId === "TASK-1")?.id ?? "";
        request2 = all.find((r) => r.taskId === "TASK-2")?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", request1, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getHumanRequestById(db, request2)?.status).toBe("PENDING");
      } finally {
        db.close();
      }
    });

    it("decision persists between CLI processes", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      const db = openHomeDatabase(home);
      try {
        expect(getHumanRequestById(db, requestId)?.status).toBe("RESOLVED");
        expect(getTaskById(db, "TASK-DEC")?.state).toBe("GENERATING_CONTRACT");
      } finally {
        db.close();
      }
    });

    it("request list no longer shows the resolved request", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      const result = runCli(["request", "list", "--task", "TASK-DEC"], { home, cwd });
      expect(result.stdout).toContain("Solicitudes pendientes para TASK-DEC: 0");
    });

    it("the external repository remains clean", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(gitRepository.runGit(["status", "--short"])).toBe("");
    });

    it("does not run OpenCode", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.stdout).not.toContain("opencode");
      expect(result.stderr).not.toContain("opencode");
    });

    it("does not create additional worktrees", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "CANCEL_TASK"],
        { home, cwd },
      );

      expect(result.exitCode).toBe(0);
      expectNoisyOrEmptyStderr(result.stderr);

      const worktrees = gitRepository.runGit(["worktree", "list", "--porcelain"]);
      const entries = worktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree "));

      expect(entries).toHaveLength(1);
      expect(entries[0]).toBe(`worktree ${gitRepository.path}`);
    });
  });

  describe("format", () => {
    it("stdout has exactly seven lines", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout.split("\n")).toHaveLength(7);
    });

    it("stdout does not contain resolutionJson", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout).not.toContain("resolutionJson");
    });

    it("stdout does not contain optionsJson", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout).not.toContain("optionsJson");
    });

    it("stdout does not contain question", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout).not.toContain("Pregunta");
    });

    it("stdout does not contain comment", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout).not.toContain("Simplify");
    });

    it("stdout does not contain contractJson", () => {
      ({ homeDirectory, fixtureDirectory, gitRepository } = setupDecompositionRequest());
      const home = homeDirectory.path;
      const cwd = fixtureDirectory.path;

      const database = openHomeDatabase(home);
      let requestId = "";
      try {
        requestId = listPendingHumanRequests(database)[0]?.id ?? "";
      } finally {
        database.close();
      }

      const result = runCli(
        ["request", "decide", "--request", requestId, "--decision", "EDIT_DECOMPOSITION", "--comment", "Simplify"],
        { home, cwd },
      );

      expect(result.stdout).not.toContain("contractJson");
    });

    it("request decide appears in --help", () => {
      const homeDirectory = createTempDirectory();
      const home = homeDirectory.path;

      const result = runCli(["request", "decide", "--help"], { home });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--request <request-id>");
      expect(result.stdout).toContain("--decision <decision>");
      expect(result.stdout).toContain("--comment <text>");
      homeDirectory.cleanup();
    });
  });
});
