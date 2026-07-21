import { afterEach, describe, expect, it } from "vitest";

import { initializeSchema, openDatabase } from "../../src/db.js";
import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import {
  createTaskWorkspace,
  updateTaskWorkspaceStatus,
} from "../../src/repositories/task-workspace-repository.js";
import {
  claimReviewerRun,
  ReviewerClaimError,
  type ClaimReviewerRunInput,
} from "../../src/services/reviewer-claim-service.js";
import type { Project, Task, TaskWorkspace } from "../../src/types.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";

type TaskOverrides = Partial<Task> & { correctionCount?: number };
type WorkspaceOverrides = Partial<TaskWorkspace>;

function createTestProject(tempDb: TempDatabase, id: string = "proj-1"): Project {
  return createProject(tempDb.database, {
    id,
    name: `Project ${id}`,
    repositoryPath: "/tmp/test",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function createTestTask(
  tempDb: TempDatabase,
  projectId: string,
  overrides: TaskOverrides = {},
): Task {
  const task = createTask(tempDb.database, {
    id: overrides.id ?? "task-1",
    projectId,
    title: overrides.title ?? "Test Task",
    description: overrides.description ?? "A test task",
    state: overrides.state ?? "REVIEWING",
    attempt: overrides.attempt ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    contractJson: overrides.contractJson ?? null,
    currentRevisionJson: overrides.currentRevisionJson ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  });

  if (overrides.correctionCount !== undefined) {
    tempDb.database
      .prepare("UPDATE tasks SET correctionCount = ? WHERE id = ?")
      .run(overrides.correctionCount, task.id);
  }

  return task;
}

function createPreparingWorkspace(
  tempDb: TempDatabase,
  taskId: string,
  overrides: WorkspaceOverrides = {},
): TaskWorkspace {
  return createTaskWorkspace(tempDb.database, {
    id: overrides.id ?? `ws-${taskId}`,
    taskId,
    executionNumber: overrides.executionNumber ?? 1,
    workspacePath: overrides.workspacePath ?? `/tmp/workspaces/${taskId}`,
    branchName: overrides.branchName ?? `task/${taskId}`,
    baseCommit: overrides.baseCommit ?? "abc123def456",
  });
}

function createReadyWorkspace(
  tempDb: TempDatabase,
  taskId: string,
  overrides: WorkspaceOverrides = {},
): TaskWorkspace {
  const workspace = createPreparingWorkspace(tempDb, taskId, overrides);
  return updateTaskWorkspaceStatus(tempDb.database, workspace.id, "READY");
}

function defaultClaimInput(overrides: Partial<ClaimReviewerRunInput> = {}): ClaimReviewerRunInput {
  return {
    reviewId: overrides.reviewId ?? "review-1",
    taskId: overrides.taskId ?? "task-1",
    workspaceId: overrides.workspaceId ?? "ws-task-1",
    reviewerClaimJson: overrides.reviewerClaimJson ?? '{"kind":"REVIEWER_CLAIM"}',
    snapshotBaseCommit: overrides.snapshotBaseCommit ?? "abc123def456",
    snapshotHeadCommit: overrides.snapshotHeadCommit ?? "789ghi012jkl",
    snapshotFingerprint: overrides.snapshotFingerprint ?? "fingerprint-abc",
  };
}

function expectReviewerClaimError(
  callback: () => unknown,
  expectedCode: string,
): ReviewerClaimError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerClaimError);
    expect((error as ReviewerClaimError).code).toBe(expectedCode);
    return error as ReviewerClaimError;
  }

  throw new Error(`Expected ReviewerClaimError with code ${expectedCode}`);
}

function readReviewCount(tempDb: TempDatabase, taskId: string): number {
  const row = tempDb.database
    .prepare("SELECT COUNT(*) AS count FROM task_reviews WHERE taskId = ?")
    .get(taskId) as { count: number };

  return row.count;
}

describe("reviewer-claim-service", () => {
  let tempDb: TempDatabase | null = null;

  afterEach(() => {
    tempDb?.cleanup();
    tempDb = null;
  });

  describe("claimReviewerRun", () => {
    it("initial claim with correctionCount 0 produces reviewNumber 1 and runNumber 1", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { correctionCount: 0 });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.reviewNumber).toBe(1);
      expect(result.runNumber).toBe(1);
      expect(result.status).toBe("RUNNING");
    });

    it("correctionCount 1 produces reviewNumber 2", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { correctionCount: 1 });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.reviewNumber).toBe(2);
      expect(result.runNumber).toBe(1);
    });

    it("retry after DISCARDED preserves reviewNumber and increments runNumber", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const first = claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-1",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      tempDb.database
        .prepare(
          "UPDATE task_reviews SET status = 'DISCARDED', reviewerClaimJson = NULL, discardReason = ?, discardedAt = ? WHERE id = ?",
        )
        .run("test", new Date().toISOString(), first.id);

      const second = claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-2",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(second.reviewNumber).toBe(1);
      expect(second.runNumber).toBe(2);
    });

    it("multiple discarded previous runs produce the next runNumber", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      for (let index = 1; index <= 3; index += 1) {
        const review = claimReviewerRun(tempDb.database, defaultClaimInput({
          reviewId: `review-${String(index)}`,
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        }));

        tempDb.database
          .prepare(
            "UPDATE task_reviews SET status = 'DISCARDED', reviewerClaimJson = NULL, discardReason = ?, discardedAt = ? WHERE id = ?",
          )
          .run("test", new Date().toISOString(), review.id);
      }

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-4",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.reviewNumber).toBe(1);
      expect(result.runNumber).toBe(4);
    });

    it("fails when task does not exist", () => {
      tempDb = createTempDatabase();

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({ taskId: "missing-task" })),
        "REVIEWER_CLAIM_TASK_NOT_FOUND",
      );
    });

    it("fails when task is not REVIEWING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_TASK_NOT_REVIEWING",
      );
    });

    it("fails when workspace does not exist", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({ taskId: task.id, workspaceId: "missing-ws" })),
        "REVIEWER_CLAIM_WORKSPACE_NOT_FOUND",
      );
    });

    it("fails when workspace belongs to another task", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const taskA = createTestTask(tempDb, project.id, { id: "task-a" });
      const taskB = createTestTask(tempDb, project.id, { id: "task-b" });
      const workspace = createReadyWorkspace(tempDb, taskA.id, { id: "ws-task-a" });

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          taskId: taskB.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_WORKSPACE_TASK_MISMATCH",
      );
    });

    it("fails explicitly when workspace is PREPARING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createPreparingWorkspace(tempDb, task.id, { id: "ws-task-1" });

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_WORKSPACE_NOT_READY",
      );
    });

    it("fails explicitly when workspace baseCommit differs from snapshotBaseCommit", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, {
        id: "ws-task-1",
        baseCommit: "base-from-workspace",
      });

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: "different-base-commit",
        })),
        "REVIEWER_CLAIM_WORKSPACE_NOT_READY",
      );
    });

    it("blocks a new claim when a RUNNING review already exists", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-1",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          reviewId: "review-2",
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_ALREADY_RUNNING",
      );
    });

    it("blocks a new claim when the current reviewNumber already has a COMPLETED review", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const review = claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-1",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      tempDb.database
        .prepare(
          `UPDATE task_reviews
             SET status = 'COMPLETED',
                 reviewerClaimJson = NULL,
                 verdict = 'APPROVED',
                 summary = 'ok',
                 findingsJson = '[]',
                 requiredChangesJson = '[]',
                 completedAt = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), review.id);

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          reviewId: "review-2",
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_REVIEW_ALREADY_COMPLETED",
      );
    });

    it("does not block the next cycle when a previous reviewNumber is COMPLETED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { correctionCount: 0 });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const review = claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-1",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      tempDb.database
        .prepare(
          `UPDATE task_reviews
             SET status = 'COMPLETED',
                 reviewerClaimJson = NULL,
                 verdict = 'REVISION_REQUIRED',
                 summary = 'needs work',
                 findingsJson = '[]',
                 requiredChangesJson = '[]',
                 completedAt = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), review.id);
      tempDb.database.prepare("UPDATE tasks SET correctionCount = 1 WHERE id = ?").run(task.id);

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-2",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.reviewNumber).toBe(2);
      expect(result.runNumber).toBe(1);
    });

    it("classifies duplicate reviewId after validation as REVIEWER_CLAIM_CONFLICT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-1",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      tempDb.database
        .prepare(
          "UPDATE task_reviews SET status = 'DISCARDED', reviewerClaimJson = NULL, discardReason = ?, discardedAt = ? WHERE id = ?",
        )
        .run("test", new Date().toISOString(), "review-1");

      const error = expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          reviewId: "review-1",
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_CONFLICT",
      );

      expect(error.cause).toBeDefined();
      expect(readReviewCount(tempDb, task.id)).toBe(1);
    });

    it("persists snapshotWorkspaceId exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.snapshotWorkspaceId).toBe(workspace.id);
    });

    it("persists snapshotBaseCommit exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, {
        id: "ws-task-1",
        baseCommit: "custom-base-commit-12345",
      });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.snapshotBaseCommit).toBe("custom-base-commit-12345");
    });

    it("persists snapshotHeadCommit exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
        snapshotHeadCommit: "custom-head-commit-67890",
      }));

      expect(result.snapshotHeadCommit).toBe("custom-head-commit-67890");
    });

    it("persists snapshotFingerprint exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
        snapshotFingerprint: "sha256-abcdef1234567890",
      }));

      expect(result.snapshotFingerprint).toBe("sha256-abcdef1234567890");
    });

    it("persists reviewerClaimJson exactly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });
      const reviewerClaimJson = '{"kind":"REVIEWER_CLAIM","custom":"data"}';

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
        reviewerClaimJson,
      }));

      expect(result.reviewerClaimJson).toBe(reviewerClaimJson);
    });

    it("keeps Task.state as REVIEWING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "REVIEWING" });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("REVIEWING");
    });

    it("does not change correctionCount", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { correctionCount: 2 });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      const row = tempDb.database
        .prepare("SELECT correctionCount FROM tasks WHERE id = ?")
        .get(task.id) as { correctionCount: number };

      expect(row.correctionCount).toBe(2);
    });

    it("does not change the workspace row", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      const row = tempDb.database
        .prepare("SELECT status, baseCommit, taskId FROM task_workspaces WHERE id = ?")
        .get(workspace.id) as Record<string, unknown>;

      expect(String(row["status"])).toBe("READY");
      expect(String(row["baseCommit"])).toBe(workspace.baseCommit);
      expect(String(row["taskId"])).toBe(task.id);
    });

    it("rolls back after an insert conflict without creating extra rows", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        reviewId: "review-1",
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));
      tempDb.database
        .prepare(
          "UPDATE task_reviews SET status = 'DISCARDED', reviewerClaimJson = NULL, discardReason = ?, discardedAt = ? WHERE id = ?",
        )
        .run("test", new Date().toISOString(), "review-1");

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          reviewId: "review-1",
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_CONFLICT",
      );

      expect(readReviewCount(tempDb, task.id)).toBe(1);
      const runningCount = tempDb.database
        .prepare("SELECT COUNT(*) AS count FROM task_reviews WHERE taskId = ? AND status = 'RUNNING'")
        .get(task.id) as { count: number };
      expect(runningCount.count).toBe(0);
    });

    it("validation errors do not create new rows", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createPreparingWorkspace(tempDb, task.id, { id: "ws-task-1" });

      expectReviewerClaimError(
        () => claimReviewerRun(tempDb!.database, defaultClaimInput({
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        })),
        "REVIEWER_CLAIM_WORKSPACE_NOT_READY",
      );

      expect(readReviewCount(tempDb, task.id)).toBe(0);
    });

    it("connection B receives ALREADY_RUNNING after connection A commits a claim", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });
      const secondDb = openDatabase(tempDb.databasePath);
      initializeSchema(secondDb);

      try {
        claimReviewerRun(tempDb.database, defaultClaimInput({
          reviewId: "review-a",
          taskId: task.id,
          workspaceId: workspace.id,
          snapshotBaseCommit: workspace.baseCommit,
        }));

        expectReviewerClaimError(
          () => claimReviewerRun(secondDb, defaultClaimInput({
            reviewId: "review-b",
            taskId: task.id,
            workspaceId: workspace.id,
            snapshotBaseCommit: workspace.baseCommit,
          })),
          "REVIEWER_CLAIM_ALREADY_RUNNING",
        );

        const row = tempDb.database
          .prepare("SELECT COUNT(*) AS count FROM task_reviews WHERE taskId = ? AND status = 'RUNNING'")
          .get(task.id) as { count: number };
        expect(row.count).toBe(1);
      } finally {
        secondDb.close();
      }
    });

    it("returns REVIEWER_CLAIM_PERSISTENCE_FAILED with SQLITE_BUSY cause when another connection holds a write lock", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });
      const secondDb = openDatabase(tempDb.databasePath);
      initializeSchema(secondDb);

      try {
        tempDb.database.prepare("BEGIN IMMEDIATE").run();

        const error = expectReviewerClaimError(
          () => claimReviewerRun(secondDb, defaultClaimInput({
            reviewId: "review-b",
            taskId: task.id,
            workspaceId: workspace.id,
            snapshotBaseCommit: workspace.baseCommit,
          })),
          "REVIEWER_CLAIM_PERSISTENCE_FAILED",
        );

        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as Error).message).toMatch(/SQLITE_BUSY|database is locked/i);
        expect(readReviewCount(tempDb, task.id)).toBe(0);
      } finally {
        try {
          tempDb.database.prepare("ROLLBACK").run();
        } catch (rollbackError: unknown) {
          void rollbackError;
        }
        secondDb.close();
      }
    });

    it("does not execute Git", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.status).toBe("RUNNING");
    });

    it("does not execute OpenCode", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      const result = claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      expect(result.status).toBe("RUNNING");
    });
  });
});
