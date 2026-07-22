import { afterEach, describe, expect, it } from "vitest";

import { initializeSchema, openDatabase } from "../../src/db.js";
import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import {
  createTaskWorkspace,
  updateTaskWorkspaceStatus,
} from "../../src/repositories/task-workspace-repository.js";
import {
  assertReviewerEvidenceSnapshotStillOwned,
  claimReviewerRun,
  loadReviewerEvidenceSnapshot,
  ReviewerClaimError,
  type ClaimReviewerRunInput,
  type ReviewerEvidenceSnapshot,
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

const CONTRACT_JSON = '{"classification":"EXECUTABLE_TASK","objective":"Implement","context":"Context","acceptanceCriteria":["Works"],"allowedPaths":["src"],"forbiddenPaths":[],"requiredCommands":[],"assumptions":[],"risks":[],"summary":"Summary","reasoning":"Reasoning","openQuestions":[]}';
const REVISION_JSON = '{"taskId":"task-1","projectId":"proj-1","workspaceId":"ws-task-1","baseCommit":"abc123def456","changedFiles":[],"pathValidation":{"passed":true,"violations":[]},"commandsResult":null,"status":"REVIEWING","generatedAt":"2026-07-22T00:00:00.000Z"}';
const CLAIM_JSON = '{"kind":"REVIEWER_CLAIM","agent":"reviewer-a"}';

let tempDb: TempDatabase | null = null;

function createClaimedEvidenceSnapshotFixture(): ReviewerEvidenceSnapshot {
  tempDb = createTempDatabase();
  const project = createTestProject(tempDb);
  const task = createTestTask(tempDb, project.id, {
    contractJson: CONTRACT_JSON,
    currentRevisionJson: REVISION_JSON,
  });
  const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

  claimReviewerRun(tempDb.database, defaultClaimInput({
    taskId: task.id,
    workspaceId: workspace.id,
    reviewerClaimJson: CLAIM_JSON,
    snapshotBaseCommit: workspace.baseCommit,
    snapshotHeadCommit: "head-commit-123",
    snapshotFingerprint: "fingerprint-123",
  }));

  return loadReviewerEvidenceSnapshot(tempDb.database, {
    taskId: task.id,
    reviewId: "review-1",
    expectedReviewerClaimJson: CLAIM_JSON,
  });
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

  describe("ReviewerEvidenceSnapshot read-only API", () => {
    function loadSnapshot(): ReviewerEvidenceSnapshot {
      return loadReviewerEvidenceSnapshot(tempDb!.database, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: CLAIM_JSON,
      });
    }

    function expectSnapshotError(callback: () => unknown, expectedCode: string): ReviewerClaimError {
      return expectReviewerClaimError(callback, expectedCode);
    }

    function disableChecksForCorruption(): void {
      tempDb!.database.exec("PRAGMA ignore_check_constraints = ON;");
    }

    function enableChecksAfterCorruption(): void {
      tempDb!.database.exec("PRAGMA ignore_check_constraints = OFF;");
    }

    function updateReviewField(fieldName: string, value: string | number | null): void {
      tempDb!.database.prepare(`UPDATE task_reviews SET ${fieldName} = ? WHERE id = ?`).run(value, "review-1");
    }

    function updateTaskField(fieldName: string, value: string | null): void {
      tempDb!.database.prepare(`UPDATE tasks SET ${fieldName} = ? WHERE id = ?`).run(value, "task-1");
    }

    function updateWorkspaceField(fieldName: string, value: string | null): void {
      tempDb!.database.prepare(`UPDATE task_workspaces SET ${fieldName} = ? WHERE id = ?`).run(value, "ws-task-1");
    }

    function snapshotWith(overrides: Partial<ReviewerEvidenceSnapshot>): ReviewerEvidenceSnapshot {
      return {
        ...createClaimedEvidenceSnapshotFixture(),
        ...overrides,
      };
    }

    it("loads a valid snapshot with exact persisted fields", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();

      expect(snapshot).toEqual({
        taskId: "task-1",
        projectId: "proj-1",
        reviewId: "review-1",
        reviewNumber: 1,
        runNumber: 1,
        reviewStatus: "RUNNING",
        reviewerClaimJson: CLAIM_JSON,
        snapshotWorkspaceId: "ws-task-1",
        snapshotBaseCommit: "abc123def456",
        snapshotHeadCommit: "head-commit-123",
        snapshotFingerprint: "fingerprint-123",
        taskState: "REVIEWING",
        contractJson: CONTRACT_JSON,
        currentRevisionJson: REVISION_JSON,
        workspaceId: "ws-task-1",
        workspaceTaskId: "task-1",
        workspacePath: "/tmp/workspaces/task-1",
        workspaceBaseCommit: "abc123def456",
        workspaceStatus: "READY",
      });
    });

    it("revalidates unchanged snapshot and returns void", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      expect(assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot)).toBeUndefined();
    });

    it("preserves exact JSON strings without reserialization", () => {
      const spacedClaim = '{ "kind" : "REVIEWER_CLAIM", "agent" : "reviewer-a" }';
      const spacedContract = '{ "classification" : "EXECUTABLE_TASK" }';
      const spacedRevision = '{ "status" : "REVIEWING" }';
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        contractJson: spacedContract,
        currentRevisionJson: spacedRevision,
      });
      const workspace = createReadyWorkspace(tempDb, task.id, { id: "ws-task-1" });

      claimReviewerRun(tempDb.database, defaultClaimInput({
        taskId: task.id,
        workspaceId: workspace.id,
        reviewerClaimJson: spacedClaim,
        snapshotBaseCommit: workspace.baseCommit,
      }));

      const snapshot = loadReviewerEvidenceSnapshot(tempDb.database, {
        taskId: task.id,
        reviewId: "review-1",
        expectedReviewerClaimJson: spacedClaim,
      });

      expect(snapshot.reviewerClaimJson).toBe(spacedClaim);
      expect(snapshot.contractJson).toBe(spacedContract);
      expect(snapshot.currentRevisionJson).toBe(spacedRevision);
    });

    it("does not modify rows or timestamps", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      const beforeReview = tempDb!.database.prepare("SELECT * FROM task_reviews WHERE id = ?").get("review-1");
      const beforeTask = tempDb!.database.prepare("SELECT * FROM tasks WHERE id = ?").get("task-1");
      const beforeWorkspace = tempDb!.database.prepare("SELECT * FROM task_workspaces WHERE id = ?").get("ws-task-1");
      const beforeReviewCount = readReviewCount(tempDb!, "task-1");

      assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot);

      expect(tempDb!.database.prepare("SELECT * FROM task_reviews WHERE id = ?").get("review-1")).toEqual(beforeReview);
      expect(tempDb!.database.prepare("SELECT * FROM tasks WHERE id = ?").get("task-1")).toEqual(beforeTask);
      expect(tempDb!.database.prepare("SELECT * FROM task_workspaces WHERE id = ?").get("ws-task-1")).toEqual(beforeWorkspace);
      expect(readReviewCount(tempDb!, "task-1")).toBe(beforeReviewCount);
    });

    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "", reviewId: "review-1", expectedReviewerClaimJson: CLAIM_JSON }),
        "REVIEWER_EVIDENCE_INVALID_INPUT",
      );
    });

    it("rejects empty reviewId", () => {
      tempDb = createTempDatabase();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "task-1", reviewId: "", expectedReviewerClaimJson: CLAIM_JSON }),
        "REVIEWER_EVIDENCE_INVALID_INPUT",
      );
    });

    it("rejects empty expectedReviewerClaimJson", () => {
      tempDb = createTempDatabase();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "task-1", reviewId: "review-1", expectedReviewerClaimJson: "" }),
        "REVIEWER_EVIDENCE_INVALID_INPUT",
      );
    });

    it("rejects invalid snapshot on revalidation", () => {
      const snapshot = snapshotWith({ reviewId: "" });
      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_INVALID_INPUT",
      );
    });

    it("rejects missing review", () => {
      tempDb = createTempDatabase();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "task-1", reviewId: "missing", expectedReviewerClaimJson: CLAIM_JSON }),
        "REVIEWER_EVIDENCE_REVIEW_NOT_FOUND",
      );
    });

    it("rejects review belonging to another task", () => {
      createClaimedEvidenceSnapshotFixture();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "other-task", reviewId: "review-1", expectedReviewerClaimJson: CLAIM_JSON }),
        "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED",
      );
    });

    it("rejects different claim", () => {
      createClaimedEvidenceSnapshotFixture();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "task-1", reviewId: "review-1", expectedReviewerClaimJson: "different" }),
        "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED",
      );
    });

    it("rejects null claim", () => {
      createClaimedEvidenceSnapshotFixture();
      disableChecksForCorruption();
      updateReviewField("reviewerClaimJson", null);
      enableChecksAfterCorruption();

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED");
    });

    it("rejects COMPLETED review", () => {
      createClaimedEvidenceSnapshotFixture();
      tempDb!.database
        .prepare("UPDATE task_reviews SET status = 'COMPLETED', reviewerClaimJson = NULL, verdict = 'APPROVED', summary = 'ok', findingsJson = '[]', requiredChangesJson = '[]', completedAt = ? WHERE id = ?")
        .run("2026-07-22T00:00:00.000Z", "review-1");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED");
    });

    it("rejects DISCARDED review", () => {
      createClaimedEvidenceSnapshotFixture();
      tempDb!.database
        .prepare("UPDATE task_reviews SET status = 'DISCARDED', reviewerClaimJson = NULL, discardReason = 'test', discardedAt = ? WHERE id = ?")
        .run("2026-07-22T00:00:00.000Z", "review-1");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED");
    });

    it("detects reviewNumber change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateReviewField("reviewNumber", 2);

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED",
      );
    });

    it("detects runNumber change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateReviewField("runNumber", 2);

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED",
      );
    });

    it("rejects semantically equivalent but string-different claim", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateReviewField("reviewerClaimJson", '{ "kind" : "REVIEWER_CLAIM", "agent" : "reviewer-a" }');

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED",
      );
    });

    it.each([
      ["snapshotWorkspaceId"],
      ["snapshotBaseCommit"],
      ["snapshotHeadCommit"],
      ["snapshotFingerprint"],
    ])("rejects null %s", (fieldName) => {
      createClaimedEvidenceSnapshotFixture();
      disableChecksForCorruption();
      updateReviewField(fieldName, null);
      enableChecksAfterCorruption();

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_SNAPSHOT_INVALID");
    });

    it("rejects missing workspace", () => {
      createClaimedEvidenceSnapshotFixture();
      tempDb!.database.exec("PRAGMA foreign_keys = OFF;");
      tempDb!.database.prepare("DELETE FROM task_workspaces WHERE id = ?").run("ws-task-1");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_WORKSPACE_NOT_FOUND");
    });

    it("rejects workspace belonging to another task", () => {
      createClaimedEvidenceSnapshotFixture();
      createTestTask(tempDb!, "proj-1", { id: "task-2", contractJson: CONTRACT_JSON, currentRevisionJson: REVISION_JSON });
      updateWorkspaceField("taskId", "task-2");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_SNAPSHOT_INVALID");
    });

    it("rejects workspace not READY", () => {
      createClaimedEvidenceSnapshotFixture();
      updateWorkspaceField("status", "FAILED");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_SNAPSHOT_INVALID");
    });

    it("detects workspace baseCommit change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateWorkspaceField("baseCommit", "other-base");

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED",
      );
    });

    it("detects workspacePath change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateWorkspaceField("workspacePath", "/tmp/workspaces/other");

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED",
      );
    });

    it.each([
      ["snapshotBaseCommit"],
      ["snapshotHeadCommit"],
      ["snapshotFingerprint"],
    ])("detects %s change during revalidation", (fieldName) => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      if (fieldName === "snapshotBaseCommit") {
        updateWorkspaceField("baseCommit", "changed-value");
      }
      updateReviewField(fieldName, "changed-value");

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED",
      );
    });

    it("rejects missing task", () => {
      createClaimedEvidenceSnapshotFixture();
      tempDb!.database.exec("PRAGMA foreign_keys = OFF;");
      tempDb!.database.prepare("DELETE FROM tasks WHERE id = ?").run("task-1");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_TASK_NOT_FOUND");
    });

    it("rejects task outside REVIEWING", () => {
      createClaimedEvidenceSnapshotFixture();
      updateTaskField("state", "EXECUTING");

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_TASK_STATE_CHANGED");
    });

    it("detects projectId change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      createTestProject(tempDb!, "proj-2");
      updateTaskField("projectId", "proj-2");

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_TASK_STATE_CHANGED",
      );
    });

    it("rejects null contractJson", () => {
      createClaimedEvidenceSnapshotFixture();
      updateTaskField("contractJson", null);

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_CONTRACT_CHANGED");
    });

    it("detects contractJson change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateTaskField("contractJson", "changed-contract");

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_CONTRACT_CHANGED",
      );
    });

    it("rejects null currentRevisionJson", () => {
      createClaimedEvidenceSnapshotFixture();
      updateTaskField("currentRevisionJson", null);

      expectSnapshotError(loadSnapshot, "REVIEWER_EVIDENCE_REVISION_CHANGED");
    });

    it("detects currentRevisionJson change during revalidation", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      updateTaskField("currentRevisionJson", "changed-revision");

      expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_REVISION_CHANGED",
      );
    });

    it("wraps unexpected SQLite errors with cause", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      tempDb!.close();

      const error = expectSnapshotError(
        () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
        "REVIEWER_EVIDENCE_PERSISTENCE_FAILED",
      );
      expect(error.cause).toBeInstanceOf(Error);
    });

    it("keeps connection usable after a validation error", () => {
      createClaimedEvidenceSnapshotFixture();
      expectSnapshotError(
        () => loadReviewerEvidenceSnapshot(tempDb!.database, { taskId: "task-1", reviewId: "review-1", expectedReviewerClaimJson: "wrong" }),
        "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED",
      );

      expect(loadSnapshot().reviewId).toBe("review-1");
    });

    it("detects changes made by a second connection", () => {
      const snapshot = createClaimedEvidenceSnapshotFixture();
      const secondDb = openDatabase(tempDb!.databasePath);
      initializeSchema(secondDb);

      try {
        secondDb.prepare("UPDATE task_reviews SET reviewerClaimJson = ? WHERE id = ?").run("stolen", "review-1");

        expectSnapshotError(
          () => assertReviewerEvidenceSnapshotStillOwned(tempDb!.database, snapshot),
          "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED",
        );
      } finally {
        secondDb.close();
      }
    });
  });
});
