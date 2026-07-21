import { afterEach, describe, expect, it } from "vitest";

import { initializeSchema, openDatabase } from "../../src/db.js";
import { createProject } from "../../src/repositories/project-repository.js";
import {
  claimTaskDeterministicRevision,
  createTask,
  finalizeTaskDeterministicRevision,
  getTaskById,
  type DeterministicRevisionFinalState,
} from "../../src/repositories/task-repository.js";
import type { Project, Task } from "../../src/types.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";

function createTestProject(tempDb: TempDatabase): Project {
  return createProject(tempDb.database, {
    id: "proj-1",
    name: "Test Project",
    repositoryPath: "/tmp/test",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function createTestTask(
  tempDb: TempDatabase,
  projectId: string,
  overrides: Partial<Task> = {},
): Task {
  return createTask(tempDb.database, {
    id: overrides.id ?? "task-1",
    projectId,
    title: overrides.title ?? "Test Task",
    description: overrides.description ?? "A test task",
    state: overrides.state ?? "VERIFYING",
    attempt: overrides.attempt ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    contractJson: overrides.contractJson ?? null,
    currentRevisionJson: overrides.currentRevisionJson ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  });
}

function readTaskRow(tempDb: TempDatabase, taskId: string): Record<string, unknown> {
  return tempDb.database
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as Record<string, unknown>;
}

function claimJson(
  claimId: string,
  taskId: string = "task-1",
  claimedAt: string = "2026-07-20T12:00:00.000Z",
): string {
  return JSON.stringify({
    kind: "DETERMINISTIC_REVISION_CLAIM",
    claimId,
    taskId,
    claimedAt,
  });
}

function finalRevisionJson(
  status: DeterministicRevisionFinalState,
  taskId: string = "task-1",
): string {
  return JSON.stringify({
    taskId,
    projectId: "proj-1",
    workspaceId: "ws-1",
    baseCommit: "abc123",
    changedFiles: [],
    pathValidation: { passed: status === "REVIEWING", violations: [] },
    commandsResult: null,
    status,
    generatedAt: "2026-07-20T12:00:00.000Z",
  });
}

describe("task-repository deterministic revision primitives", () => {
  let tempDb: TempDatabase | null = null;

  afterEach(() => {
    tempDb?.cleanup();
    tempDb = null;
  });

  describe("claimTaskDeterministicRevision", () => {
    it("acquires a claim when VERIFYING and currentRevisionJson is null", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: null });
      const updatedAt = "2026-07-20T12:01:00.000Z";
      const claim = claimJson("claim-1", task.id);

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claim,
        updatedAt,
      );

      expect(acquired).toBe(true);
    });

    it("acquires a claim when the expected string matches", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        currentRevisionJson: JSON.stringify({ previous: true }),
      });
      const claim = claimJson("claim-1", task.id);

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        JSON.stringify({ previous: true }),
        claim,
        "2026-07-20T12:01:00.000Z",
      );

      expect(acquired).toBe(true);
    });

    it("writes the exact claimJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const claim = claimJson("claim-1", task.id);

      claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claim,
        "2026-07-20T12:01:00.000Z",
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["currentRevisionJson"])).toBe(claim);
    });

    it("updates updatedAt exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const updatedAt = "2026-07-20T12:01:00.000Z";

      claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claimJson("claim-1", task.id),
        updatedAt,
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["updatedAt"])).toBe(updatedAt);
    });

    it("does not change state", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });

      claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claimJson("claim-1", task.id),
        "2026-07-20T12:01:00.000Z",
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["state"])).toBe("VERIFYING");
    });

    it("fails for a nonexistent Task", () => {
      tempDb = createTempDatabase();

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        "missing",
        null,
        claimJson("claim-1", "missing"),
        "2026-07-20T12:01:00.000Z",
      );

      expect(acquired).toBe(false);
    });

    it("fails when the Task is not VERIFYING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claimJson("claim-1", task.id),
        "2026-07-20T12:01:00.000Z",
      );

      expect(acquired).toBe(false);
      expect(getTaskById(tempDb.database, task.id)?.currentRevisionJson).toBeNull();
    });

    it("fails when expected null but a value exists", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const existing = JSON.stringify({ previous: true });
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: existing });

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claimJson("claim-1", task.id),
        "2026-07-20T12:01:00.000Z",
      );

      expect(acquired).toBe(false);
      expect(getTaskById(tempDb.database, task.id)?.currentRevisionJson).toBe(existing);
    });

    it("fails when the expected string does not match", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        currentRevisionJson: JSON.stringify({ previous: true }),
      });

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        JSON.stringify({ previous: false }),
        claimJson("claim-1", task.id),
        "2026-07-20T12:01:00.000Z",
      );

      expect(acquired).toBe(false);
    });

    it("fails when another claim has already been acquired", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const firstClaim = claimJson("claim-1", task.id);

      const first = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        firstClaim,
        "2026-07-20T12:01:00.000Z",
      );

      const second = claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claimJson("claim-2", task.id),
        "2026-07-20T12:02:00.000Z",
      );

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(getTaskById(tempDb.database, task.id)?.currentRevisionJson).toBe(firstClaim);
    });

    it("rejects invalid input", () => {
      tempDb = createTempDatabase();

      expect(() =>
        claimTaskDeterministicRevision(
          tempDb.database,
          "",
          null,
          claimJson("claim-1"),
          "2026-07-20T12:01:00.000Z",
        )).toThrow("El id de la tarea no puede estar vacío.");

      expect(() =>
        claimTaskDeterministicRevision(
          tempDb.database,
          "task-1",
          null,
          " ",
          "2026-07-20T12:01:00.000Z",
        )).toThrow("claimJson no puede estar vacío.");

      expect(() =>
        claimTaskDeterministicRevision(
          tempDb.database,
          "task-1",
          " ",
          claimJson("claim-1"),
          "2026-07-20T12:01:00.000Z",
        )).toThrow("expectedCurrentRevisionJson no puede estar vacío.");

      expect(() =>
        claimTaskDeterministicRevision(
          tempDb.database,
          "task-1",
          null,
          claimJson("claim-1"),
          " ",
        )).toThrow("updatedAt no puede estar vacío.");
    });

    it("preserves exact claimJson with surrounding whitespace", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const claim = '  {"kind":"DETERMINISTIC_REVISION_CLAIM","claimId":"c1"}  ';

      claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claim,
        "2026-07-20T12:01:00.000Z",
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["currentRevisionJson"])).toBe(claim);
    });

    it("preserves exact updatedAt with surrounding whitespace", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const updatedAt = "  2026-07-20T12:01:00.000Z  ";

      claimTaskDeterministicRevision(
        tempDb.database,
        task.id,
        null,
        claimJson("claim-1", task.id),
        updatedAt,
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["updatedAt"])).toBe(updatedAt);
    });

    it("preserves exact taskId without silent normalization", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      createTestTask(tempDb, project.id, { id: "task-1" });
      const claim = claimJson("claim-1", "task-1");

      const acquired = claimTaskDeterministicRevision(
        tempDb.database,
        "task-1",
        null,
        claim,
        "2026-07-20T12:01:00.000Z",
      );

      expect(acquired).toBe(true);
      const row = readTaskRow(tempDb, "task-1");
      expect(String(row["currentRevisionJson"])).toBe(claim);
    });

    it("propagates SQLite exceptions", () => {
      tempDb = createTempDatabase();
      tempDb.close();

      expect(() =>
        claimTaskDeterministicRevision(
          tempDb!.database,
          "task-1",
          null,
          claimJson("claim-1"),
          "2026-07-20T12:01:00.000Z",
        )).toThrow();
    });

    it("allows only one winner across two SQLite connections", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: null });
      const secondDb = openDatabase(tempDb.databasePath);
      initializeSchema(secondDb);

      try {
        const claimA = claimJson("claim-a", task.id);
        const claimB = claimJson("claim-b", task.id);

        const first = claimTaskDeterministicRevision(
          tempDb.database,
          task.id,
          null,
          claimA,
          "2026-07-20T12:01:00.000Z",
        );
        const second = claimTaskDeterministicRevision(
          secondDb,
          task.id,
          null,
          claimB,
          "2026-07-20T12:02:00.000Z",
        );

        expect([first, second].filter(Boolean)).toHaveLength(1);

        const persisted = getTaskById(tempDb.database, task.id);
        expect(persisted?.state).toBe("VERIFYING");
        expect([claimA, claimB]).toContain(persisted?.currentRevisionJson);
        expect(persisted?.currentRevisionJson).toBe(first ? claimA : claimB);
      } finally {
        secondDb.close();
      }
    });
  });

  describe("finalizeTaskDeterministicRevision", () => {
    it("finalizes with REVIEWING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claim });
      const finalJson = finalRevisionJson("REVIEWING", task.id);

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claim,
        finalJson,
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(true);
      const row = readTaskRow(tempDb, task.id);
      expect(String(row["state"])).toBe("REVIEWING");
      expect(String(row["currentRevisionJson"])).toBe(finalJson);
    });

    it("finalizes with REVISION_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claim });
      const finalJson = finalRevisionJson("REVISION_REQUIRED", task.id);

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claim,
        finalJson,
        "REVISION_REQUIRED",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(true);
      const row = readTaskRow(tempDb, task.id);
      expect(String(row["state"])).toBe("REVISION_REQUIRED");
      expect(String(row["currentRevisionJson"])).toBe(finalJson);
    });

    it("updates updatedAt exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claim });
      const updatedAt = "2026-07-20T12:03:00.000Z";

      finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claim,
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        updatedAt,
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["updatedAt"])).toBe(updatedAt);
    });

    it("succeeds only with the exact claim string", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const exactClaim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: exactClaim });

      const equivalentButDifferent =
        '{"claimId":"claim-1","kind":"DETERMINISTIC_REVISION_CLAIM","taskId":"task-1","claimedAt":"2026-07-20T12:00:00.000Z"}';

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        equivalentButDifferent,
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(false);
      expect(getTaskById(tempDb.database, task.id)?.currentRevisionJson).toBe(exactClaim);
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
    });

    it("fails if state is no longer VERIFYING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, {
        state: "REVIEWING",
        currentRevisionJson: claim,
      });

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claim,
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(false);
    });

    it("fails if the Task disappeared", () => {
      tempDb = createTempDatabase();

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        "missing",
        claimJson("claim-1", "missing"),
        finalRevisionJson("REVIEWING", "missing"),
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(false);
    });

    it("fails if currentRevisionJson was modified", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        currentRevisionJson: claimJson("claim-2"),
      });

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claimJson("claim-1"),
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(false);
    });

    it("does not change the row on failure", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const originalClaim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: originalClaim });
      const before = readTaskRow(tempDb, task.id);

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claimJson("claim-2"),
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      const after = readTaskRow(tempDb, task.id);
      expect(finalized).toBe(false);
      expect(after).toEqual(before);
    });

    it("rejects an invalid nextState", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claimJson("claim-1") });
      const fn = finalizeTaskDeterministicRevision as (
        db: unknown,
        taskId: string,
        expectedClaimJson: string,
        finalRevisionJson: string,
        nextState: string,
        updatedAt: string,
      ) => boolean;

      expect(() =>
        fn(
          tempDb.database,
          task.id,
          claimJson("claim-1"),
          finalRevisionJson("REVIEWING", task.id),
          "VERIFYING",
          "2026-07-20T12:03:00.000Z",
        )).toThrow("nextState inválido: VERIFYING");
    });

    it("rejects invalid input", () => {
      tempDb = createTempDatabase();

      expect(() =>
        finalizeTaskDeterministicRevision(
          tempDb.database,
          "",
          claimJson("claim-1"),
          finalRevisionJson("REVIEWING"),
          "REVIEWING",
          "2026-07-20T12:03:00.000Z",
        )).toThrow("El id de la tarea no puede estar vacío.");

      expect(() =>
        finalizeTaskDeterministicRevision(
          tempDb.database,
          "task-1",
          " ",
          finalRevisionJson("REVIEWING"),
          "REVIEWING",
          "2026-07-20T12:03:00.000Z",
        )).toThrow("expectedClaimJson no puede estar vacío.");

      expect(() =>
        finalizeTaskDeterministicRevision(
          tempDb.database,
          "task-1",
          claimJson("claim-1"),
          " ",
          "REVIEWING",
          "2026-07-20T12:03:00.000Z",
        )).toThrow("finalRevisionJson no puede estar vacío.");

      expect(() =>
        finalizeTaskDeterministicRevision(
          tempDb.database,
          "task-1",
          claimJson("claim-1"),
          finalRevisionJson("REVIEWING"),
          "REVIEWING",
          " ",
        )).toThrow("updatedAt no puede estar vacío.");
    });

    it("compares expectedClaimJson exactly including whitespace", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const exactClaim = '  {"kind":"claim","claimId":"c1"}  ';
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: exactClaim });

      const finalized = finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        exactClaim,
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      expect(finalized).toBe(true);
      const row = readTaskRow(tempDb, task.id);
      expect(String(row["state"])).toBe("REVIEWING");
    });

    it("preserves exact finalRevisionJson with surrounding whitespace", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claim });
      const finalJson = '  {"result":"ok"}  ';

      finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claim,
        finalJson,
        "REVIEWING",
        "2026-07-20T12:03:00.000Z",
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["currentRevisionJson"])).toBe(finalJson);
    });

    it("preserves exact updatedAt on finalization", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-1");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claim });
      const updatedAt = "  2026-07-20T12:03:00.000Z  ";

      finalizeTaskDeterministicRevision(
        tempDb.database,
        task.id,
        claim,
        finalRevisionJson("REVIEWING", task.id),
        "REVIEWING",
        updatedAt,
      );

      const row = readTaskRow(tempDb, task.id);
      expect(String(row["updatedAt"])).toBe(updatedAt);
    });

    it("fails when ownership is lost to another claim", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claimA = claimJson("claim-a");
      const claimB = claimJson("claim-b");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claimA });
      const secondDb = openDatabase(tempDb.databasePath);
      initializeSchema(secondDb);

      try {
        secondDb
          .prepare("UPDATE tasks SET currentRevisionJson = ?, updatedAt = ? WHERE id = ?")
          .run(claimB, "2026-07-20T12:04:00.000Z", task.id);

        const finalized = finalizeTaskDeterministicRevision(
          tempDb.database,
          task.id,
          claimA,
          finalRevisionJson("REVIEWING", task.id),
          "REVIEWING",
          "2026-07-20T12:05:00.000Z",
        );

        expect(finalized).toBe(false);
        const persisted = getTaskById(tempDb.database, task.id);
        expect(persisted?.state).toBe("VERIFYING");
        expect(persisted?.currentRevisionJson).toBe(claimB);
      } finally {
        secondDb.close();
      }
    });

    it("fails when the state is changed concurrently", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const claim = claimJson("claim-a");
      const task = createTestTask(tempDb, project.id, { currentRevisionJson: claim });
      const secondDb = openDatabase(tempDb.databasePath);
      initializeSchema(secondDb);

      try {
        secondDb
          .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
          .run("EXECUTING", "2026-07-20T12:04:00.000Z", task.id);

        const finalized = finalizeTaskDeterministicRevision(
          tempDb.database,
          task.id,
          claim,
          finalRevisionJson("REVIEWING", task.id),
          "REVIEWING",
          "2026-07-20T12:05:00.000Z",
        );

        expect(finalized).toBe(false);
        const persisted = getTaskById(tempDb.database, task.id);
        expect(persisted?.state).toBe("EXECUTING");
        expect(persisted?.currentRevisionJson).toBe(claim);
      } finally {
        secondDb.close();
      }
    });

    it("propagates SQLite exceptions", () => {
      tempDb = createTempDatabase();
      tempDb.close();

      expect(() =>
        finalizeTaskDeterministicRevision(
          tempDb!.database,
          "task-1",
          claimJson("claim-1"),
          finalRevisionJson("REVIEWING"),
          "REVIEWING",
          "2026-07-20T12:03:00.000Z",
        )).toThrow();
    });
  });
});
