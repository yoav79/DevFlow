import { describe, expect, it, afterEach } from "vitest";
import {
  updateTaskContract,
  getTaskContract,
  PersistedTaskContractError,
} from "../../src/repositories/task-repository.js";
import { createTask } from "../../src/repositories/task-repository.js";
import { createProject } from "../../src/repositories/project-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import type { TaskContract, Task } from "../../src/types.js";

const validContract: TaskContract = {
  classification: "EXECUTABLE_TASK",
  summary: "Add login button",
  reasoning: "Clear scope",
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

function createTestProject(tempDb: TempDatabase) {
  return createProject(tempDb.database, {
    id: "proj-1",
    name: "Test Project",
    repositoryPath: "/tmp/test",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function createTestTask(tempDb: TempDatabase, projectId: string): Task {
  return createTask(tempDb.database, {
    id: "task-1",
    projectId,
    title: "Test Task",
    description: "A test task",
    state: "CREATED",
    attempt: 0,
    maxAttempts: 3,
    contractJson: null,
    currentRevisionJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("updateTaskContract", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("saves a valid TaskContract", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const row = tempDb.database
      .prepare("SELECT contractJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(row["contractJson"]).not.toBeNull();
  });

  it("contractJson is compact JSON", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const row = tempDb.database
      .prepare("SELECT contractJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    const stored = String(row["contractJson"]);
    expect(stored).toBe(JSON.stringify(validContract));
  });

  it("does not add taskId to JSON", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const row = tempDb.database
      .prepare("SELECT contractJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    const parsed = JSON.parse(String(row["contractJson"]));
    expect(parsed.taskId).toBeUndefined();
  });

  it("does not add projectId to JSON", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const row = tempDb.database
      .prepare("SELECT contractJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    const parsed = JSON.parse(String(row["contractJson"]));
    expect(parsed.projectId).toBeUndefined();
  });

  it("does not modify state", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const updated = tempDb.database
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(updated["state"]).toBe("CREATED");
  });

  it("does not modify attempt", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const updated = tempDb.database
      .prepare("SELECT attempt FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(Number(updated["attempt"])).toBe(0);
  });

  it("does not modify currentRevisionJson", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const updated = tempDb.database
      .prepare("SELECT currentRevisionJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(updated["currentRevisionJson"]).toBeNull();
  });

  it("updates updatedAt", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", task.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const updated = tempDb.database
      .prepare("SELECT updatedAt FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(String(updated["updatedAt"])).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("replaces an existing contract", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);

    const replacement: TaskContract = {
      ...validContract,
      summary: "Updated summary",
      objective: "Updated objective",
    };
    updateTaskContract(tempDb.database, task.id, replacement);

    const result = getTaskContract(tempDb.database, task.id);
    expect(result?.summary).toBe("Updated summary");
  });

  it("does not modify the contract object received", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    const copy = JSON.parse(JSON.stringify(validContract));
    updateTaskContract(tempDb.database, task.id, validContract);
    expect(validContract).toEqual(copy);
  });

  it("rejects empty taskId", () => {
    tempDb = createTempDatabase();
    expect(() => updateTaskContract(tempDb.database, "", validContract)).toThrow(
      "El id de la tarea no puede estar vacío.",
    );
  });

  it("rejects nonexistent task", () => {
    tempDb = createTempDatabase();
    expect(() =>
      updateTaskContract(tempDb.database, "nonexistent", validContract),
    ).toThrow("No existe la tarea: nonexistent");
  });

  it("rejects structurally invalid contract", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    const invalid = { classification: "EXECUTABLE_TASK" };
    const fn = updateTaskContract as (db: unknown, id: string, c: unknown) => void;
    expect(() => fn(tempDb.database, task.id, invalid)).toThrow(
      /no es válido/,
    );
  });

  it("rejects semantically invalid contract", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    const invalid: TaskContract = {
      ...validContract,
      acceptanceCriteria: ["dup", "dup"],
    };
    expect(() => updateTaskContract(tempDb.database, task.id, invalid)).toThrow();
  });

  it("does not change contractJson if validation fails", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    try {
      updateTaskContract(tempDb.database, task.id, {
        ...validContract,
        acceptanceCriteria: ["dup", "dup"],
      });
    } catch {
      // expected
    }

    const row = tempDb.database
      .prepare("SELECT contractJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(row["contractJson"]).toBeNull();
  });
});

describe("getTaskContract", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("returns null when no contract exists", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    expect(getTaskContract(tempDb.database, task.id)).toBeNull();
  });

  it("returns a valid TaskContract after saving", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);
    const result = getTaskContract(tempDb.database, task.id);
    expect(result).toEqual(validContract);
  });

  it("round trip preserves exact data", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);
    const result = getTaskContract(tempDb.database, task.id);
    expect(result).toStrictEqual(validContract);
  });

  it("rejects empty taskId", () => {
    tempDb = createTempDatabase();
    expect(() => getTaskContract(tempDb.database, "")).toThrow(
      "El id de la tarea no puede estar vacío.",
    );
  });

  it("rejects nonexistent task", () => {
    tempDb = createTempDatabase();
    expect(() => getTaskContract(tempDb.database, "nonexistent")).toThrow(
      "No existe la tarea: nonexistent",
    );
  });

  it("encapsulates invalid JSON as PersistedTaskContractError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run("{invalid json", task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedTaskContractError);
      expect((error as PersistedTaskContractError).causeMessage).toBe("JSON inválido.");
    }
  });

  it("encapsulates invalid structure as PersistedTaskContractError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run(JSON.stringify({ classification: "INVALID" }), task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedTaskContractError);
      expect((error as PersistedTaskContractError).causeMessage).toBe("Estructura inválida.");
    }
  });

  it("encapsulates invalid semantics as PersistedTaskContractError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    const corrupt: TaskContract = {
      ...validContract,
      acceptanceCriteria: ["dup", "dup"],
    };
    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run(JSON.stringify(corrupt), task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedTaskContractError);
      expect((error as PersistedTaskContractError).causeMessage).toBe("Semántica inválida.");
    }
  });

  it("error contains taskId", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run("{bad}", task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect((error as PersistedTaskContractError).taskId).toBe(task.id);
    }
  });

  it("error has name PersistedTaskContractError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run("{bad}", task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect((error as PersistedTaskContractError).name).toBe(
        "PersistedTaskContractError",
      );
    }
  });

  it("extends Error", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run("{bad}", task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("does not expose SyntaxError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run("{bad}", task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect(error).not.toBeInstanceOf(SyntaxError);
    }
  });

  it("does not expose ZodError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run(JSON.stringify({ classification: "INVALID" }), task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect((error as Error).name).not.toBe("ZodError");
    }
  });

  it("does not expose SupervisorResultSemanticError", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    const corrupt: TaskContract = {
      ...validContract,
      acceptanceCriteria: ["dup", "dup"],
    };
    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run(JSON.stringify(corrupt), task.id);

    try {
      getTaskContract(tempDb.database, task.id);
      expect.fail("should throw");
    } catch (error) {
      expect((error as Error).name).not.toBe("SupervisorResultSemanticError");
    }
  });

  it("reading does not modify updatedAt", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", task.id);

    getTaskContract(tempDb.database, task.id);

    const row = tempDb.database
      .prepare("SELECT updatedAt FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(String(row["updatedAt"])).toBe("2000-01-01T00:00:00.000Z");
  });

  it("reading does not repair corrupt contractJson", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    tempDb.database
      .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
      .run("{bad}", task.id);

    try {
      getTaskContract(tempDb.database, task.id);
    } catch {
      // expected
    }

    const row = tempDb.database
      .prepare("SELECT contractJson FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(row["contractJson"]).toBe("{bad}");
  });
});

describe("contract isolation", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("updating one task does not affect another", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);

    const task1 = createTask(tempDb.database, {
      id: "task-1",
      projectId: project.id,
      title: "Task 1",
      description: "First",
      state: "CREATED",
      attempt: 0,
      maxAttempts: 3,
      contractJson: null,
      currentRevisionJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const task2 = createTask(tempDb.database, {
      id: "task-2",
      projectId: project.id,
      title: "Task 2",
      description: "Second",
      state: "CREATED",
      attempt: 0,
      maxAttempts: 3,
      contractJson: null,
      currentRevisionJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    updateTaskContract(tempDb.database, task1.id, validContract);

    expect(getTaskContract(tempDb.database, task2.id)).toBeNull();
  });

  it("task without contract still returns null", () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    expect(getTaskContract(tempDb.database, task.id)).toBeNull();
  });

  it("data persists after close and reopen", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);

    updateTaskContract(tempDb.database, task.id, validContract);
    tempDb.close();

    const { DatabaseSync } = await import("node:sqlite");
    const { initializeSchema } = await import("../../src/db.js");
    const db = new DatabaseSync(tempDb.databasePath);
    initializeSchema(db);

    const result = getTaskContract(db, task.id);
    expect(result).toStrictEqual(validContract);
    db.close();
  });
});
