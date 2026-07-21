import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../src/repositories/project-repository.js";
import {
  completeTaskReview,
  createTaskReview,
  discardTaskReview,
  getCompletedReviewForTaskAndReviewNumber,
  getMaxReviewNumberForTask,
  getMaxRunNumberForReview,
  getRunningReviewForTask,
  getTaskReviewById,
  listCompletedReviewsByTaskId,
  listTaskReviewsByTaskId,
  TaskReviewRepositoryError,
} from "../src/repositories/task-review-repository.js";
import { createTask, getTaskById } from "../src/repositories/task-repository.js";
import type { Project, Task } from "../src/types.js";
import { createTempDatabase, type TempDatabase } from "./helpers/temp-database.js";

function createTestProject(database: Parameters<typeof createProject>[0]): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: "alpha",
    name: "Alpha",
    repositoryPath: "/tmp/alpha",
    defaultBranch: "main",
    createdAt: now,
  };
  return createProject(database, project);
}

function createTestTask(database: Parameters<typeof createTask>[0], projectId: string = "alpha"): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: "TASK-001",
    projectId,
    title: "Test task",
    description: "For repository tests",
    state: "REVIEWING",
    attempt: 1,
    maxAttempts: 3,
    contractJson: null,
    currentRevisionJson: null,
    createdAt: now,
    updatedAt: now,
  };
  return createTask(database, task);
}

const CLAIM_A = '{"agent":"reviewer-a","ts":"2026-01-01T00:00:00.000Z"}';
const CLAIM_B = '{"agent":"reviewer-b","ts":"2026-01-01T00:00:00.000Z"}';

function insertRunningReview(
  database: Parameters<typeof createTask>[0],
  overrides: Partial<{
    id: string;
    taskId: string;
    reviewNumber: number;
    runNumber: number;
    reviewerClaimJson: string;
    snapshotWorkspaceId: string;
    snapshotBaseCommit: string;
    snapshotHeadCommit: string;
    snapshotFingerprint: string;
  }> = {},
): string {
  const defaults = {
    id: "rev-001",
    taskId: "TASK-001",
    reviewNumber: 1,
    runNumber: 1,
    reviewerClaimJson: CLAIM_A,
    snapshotWorkspaceId: "ws-001",
    snapshotBaseCommit: "base123",
    snapshotHeadCommit: "head456",
    snapshotFingerprint: "fp789",
  };
  const input = { ...defaults, ...overrides };
  createTaskReview(database, input);
  return input.reviewerClaimJson;
}

describe("task-review-repository", () => {
  let tempDb: TempDatabase | null = null;

  afterEach(() => {
    tempDb?.cleanup();
    tempDb = null;
  });

  describe("createTaskReview", () => {
    it("creates a RUNNING review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      const review = createTaskReview(tempDb.database, {
        id: "rev-001",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-001",
        snapshotBaseCommit: "base123",
        snapshotHeadCommit: "head456",
        snapshotFingerprint: "fp789",
      });

      expect(review.id).toBe("rev-001");
      expect(review.taskId).toBe("TASK-001");
      expect(review.reviewNumber).toBe(1);
      expect(review.runNumber).toBe(1);
      expect(review.status).toBe("RUNNING");
      expect(review.reviewerClaimJson).toBe(CLAIM_A);
      expect(review.verdict).toBeNull();
      expect(review.createdAt).toBeTruthy();
    });

    it("rejects duplicate (taskId, reviewNumber, runNumber)", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      createTaskReview(tempDb.database, {
        id: "rev-001",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-001",
        snapshotBaseCommit: "base123",
        snapshotHeadCommit: "head456",
        snapshotFingerprint: "fp789",
      });

      expect(() =>
        createTaskReview(tempDb!.database, {
          id: "rev-002",
          taskId: "TASK-001",
          reviewNumber: 1,
          runNumber: 1,
          reviewerClaimJson: CLAIM_B,
          snapshotWorkspaceId: "ws-002",
          snapshotBaseCommit: "base456",
          snapshotHeadCommit: "head789",
          snapshotFingerprint: "fp012",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects nonexistent taskId", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);

      expect(() =>
        createTaskReview(tempDb!.database, {
          id: "rev-001",
          taskId: "NONEXISTENT",
          reviewNumber: 1,
          runNumber: 1,
          reviewerClaimJson: CLAIM_A,
          snapshotWorkspaceId: "ws-001",
          snapshotBaseCommit: "base123",
          snapshotHeadCommit: "head456",
          snapshotFingerprint: "fp789",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects empty id", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      expect(() =>
        createTaskReview(tempDb!.database, {
          id: "",
          taskId: "TASK-001",
          reviewNumber: 1,
          runNumber: 1,
          reviewerClaimJson: CLAIM_A,
          snapshotWorkspaceId: "ws-001",
          snapshotBaseCommit: "base123",
          snapshotHeadCommit: "head456",
          snapshotFingerprint: "fp789",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects reviewNumber < 1", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      expect(() =>
        createTaskReview(tempDb!.database, {
          id: "rev-001",
          taskId: "TASK-001",
          reviewNumber: 0,
          runNumber: 1,
          reviewerClaimJson: CLAIM_A,
          snapshotWorkspaceId: "ws-001",
          snapshotBaseCommit: "base123",
          snapshotHeadCommit: "head456",
          snapshotFingerprint: "fp789",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects runNumber < 1", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      expect(() =>
        createTaskReview(tempDb!.database, {
          id: "rev-001",
          taskId: "TASK-001",
          reviewNumber: 1,
          runNumber: 0,
          reviewerClaimJson: CLAIM_A,
          snapshotWorkspaceId: "ws-001",
          snapshotBaseCommit: "base123",
          snapshotHeadCommit: "head456",
          snapshotFingerprint: "fp789",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });
  });

  describe("getTaskReviewById", () => {
    it("returns null for nonexistent id", () => {
      tempDb = createTempDatabase();
      expect(getTaskReviewById(tempDb.database, "nonexistent")).toBeNull();
    });

    it("returns the review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      createTaskReview(tempDb.database, {
        id: "rev-001",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-001",
        snapshotBaseCommit: "base123",
        snapshotHeadCommit: "head456",
        snapshotFingerprint: "fp789",
      });

      const review = getTaskReviewById(tempDb.database, "rev-001");
      expect(review).not.toBeNull();
      expect(review!.id).toBe("rev-001");
    });
  });

  describe("getRunningReviewForTask", () => {
    it("returns null when no RUNNING review", () => {
      tempDb = createTempDatabase();
      expect(getRunningReviewForTask(tempDb.database, "TASK-001")).toBeNull();
    });

    it("returns the RUNNING review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database);

      const running = getRunningReviewForTask(tempDb.database, "TASK-001");
      expect(running).not.toBeNull();
      expect(running!.id).toBe("rev-001");
    });

    it("returns null after review is completed", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database);

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "Looks good",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(getRunningReviewForTask(tempDb.database, "TASK-001")).toBeNull();
    });
  });

  describe("completeTaskReview — CAS", () => {
    it("completes with correct claim", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      const completed = completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "Looks good",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(completed.status).toBe("COMPLETED");
      expect(completed.verdict).toBe("APPROVED");
      expect(completed.summary).toBe("Looks good");
      expect(completed.completedAt).toBeTruthy();
      expect(completed.reviewerClaimJson).toBeNull();
    });

    it("rejects completion with wrong claim", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      expect(() =>
        completeTaskReview(tempDb!.database, "rev-001", CLAIM_B, {
          verdict: "APPROVED",
          summary: "ok",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);

      const review = getTaskReviewById(tempDb!.database, "rev-001");
      expect(review!.status).toBe("RUNNING");
      expect(review!.reviewerClaimJson).toBe(CLAIM_A);
    });

    it("rejects completion of already COMPLETED review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(() =>
        completeTaskReview(tempDb!.database, "rev-001", CLAIM_A, {
          verdict: "APPROVED",
          summary: "again",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects completion of DISCARDED review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned");

      expect(() =>
        completeTaskReview(tempDb!.database, "rev-001", CLAIM_A, {
          verdict: "APPROVED",
          summary: "ok",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("second complete with original claim after first succeeds fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(() =>
        completeTaskReview(tempDb!.database, "rev-001", CLAIM_A, {
          verdict: "REVISION_REQUIRED",
          summary: "oops",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("completes with REVISION_REQUIRED verdict", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      const completed = completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "REVISION_REQUIRED",
        summary: "Needs fixes",
        findingsJson: '[{"file":"src/index.ts","line":10}]',
        requiredChangesJson: '[{"description":"Fix null check"}]',
      });

      expect(completed.status).toBe("COMPLETED");
      expect(completed.verdict).toBe("REVISION_REQUIRED");
    });

    it("rejects completion of nonexistent review", () => {
      tempDb = createTempDatabase();
      expect(() =>
        completeTaskReview(tempDb.database, "nonexistent", CLAIM_A, {
          verdict: "APPROVED",
          summary: "ok",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });
  });

  describe("discardTaskReview — CAS", () => {
    it("discards with correct claim", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      const discarded = discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned_claim");

      expect(discarded.status).toBe("DISCARDED");
      expect(discarded.discardReason).toBe("orphaned_claim");
      expect(discarded.discardedAt).toBeTruthy();
      expect(discarded.reviewerClaimJson).toBeNull();
    });

    it("rejects discard with wrong claim", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      expect(() =>
        discardTaskReview(tempDb!.database, "rev-001", CLAIM_B, "reason"),
      ).toThrow(TaskReviewRepositoryError);

      const review = getTaskReviewById(tempDb!.database, "rev-001");
      expect(review!.status).toBe("RUNNING");
      expect(review!.reviewerClaimJson).toBe(CLAIM_A);
    });

    it("rejects discard of already DISCARDED review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "first");

      expect(() =>
        discardTaskReview(tempDb!.database, "rev-001", CLAIM_A, "second"),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects discard of COMPLETED review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(() =>
        discardTaskReview(tempDb!.database, "rev-001", CLAIM_A, "reason"),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("rejects discard of nonexistent review", () => {
      tempDb = createTempDatabase();
      expect(() => discardTaskReview(tempDb.database, "nonexistent", CLAIM_A, "reason")).toThrow(
        TaskReviewRepositoryError,
      );
    });
  });

  describe("cross-transition guards", () => {
    it("complete after discard fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned");

      expect(() =>
        completeTaskReview(tempDb!.database, "rev-001", CLAIM_A, {
          verdict: "APPROVED",
          summary: "ok",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("discard after complete fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(() =>
        discardTaskReview(tempDb!.database, "rev-001", CLAIM_A, "reason"),
      ).toThrow(TaskReviewRepositoryError);
    });

    it("conflict does not overwrite previous COMPLETED result", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "original",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      expect(() =>
        completeTaskReview(tempDb!.database, "rev-001", CLAIM_B, {
          verdict: "REVISION_REQUIRED",
          summary: "hijack",
          findingsJson: "[]",
          requiredChangesJson: "[]",
        }),
      ).toThrow(TaskReviewRepositoryError);

      const review = getTaskReviewById(tempDb!.database, "rev-001");
      expect(review!.verdict).toBe("APPROVED");
      expect(review!.summary).toBe("original");
    });

    it("conflict does not overwrite previous DISCARDED reason", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "original_reason");

      expect(() =>
        discardTaskReview(tempDb!.database, "rev-001", CLAIM_B, "hijack_reason"),
      ).toThrow(TaskReviewRepositoryError);

      const review = getTaskReviewById(tempDb!.database, "rev-001");
      expect(review!.discardReason).toBe("original_reason");
    });
  });

  describe("multiple DISCARDED per reviewNumber", () => {
    it("allows multiple DISCARDED for the same reviewNumber with different runNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      createTaskReview(tempDb.database, {
        id: "rev-001",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-001",
        snapshotBaseCommit: "base123",
        snapshotHeadCommit: "head456",
        snapshotFingerprint: "fp789",
      });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned_claim");

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 2,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      discardTaskReview(tempDb.database, "rev-002", CLAIM_A, "stale_claim");

      const reviews = listTaskReviewsByTaskId(tempDb.database, "TASK-001");
      expect(reviews).toHaveLength(2);
      expect(reviews.every((r) => r.status === "DISCARDED")).toBe(true);
    });
  });

  describe("immutability guards", () => {
    it("no function changes Task.state", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      const originalTask = getTaskById(tempDb.database, "TASK-001");
      expect(originalTask!.state).toBe("REVIEWING");

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      const taskAfterComplete = getTaskById(tempDb.database, "TASK-001");
      expect(taskAfterComplete!.state).toBe("REVIEWING");
    });

    it("no function changes correctionCount", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      const originalTask = getTaskById(tempDb.database, "TASK-001");

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "REVISION_REQUIRED",
        summary: "needs work",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      const taskAfter = getTaskById(tempDb.database, "TASK-001");
      expect(taskAfter!.attempt).toBe(originalTask!.attempt);
    });
  });

  describe("listTaskReviewsByTaskId", () => {
    it("returns empty array for task with no reviews", () => {
      tempDb = createTempDatabase();
      expect(listTaskReviewsByTaskId(tempDb.database, "TASK-001")).toEqual([]);
    });

    it("returns all reviews ordered by reviewNumber, runNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned_claim");

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 2,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      const reviews = listTaskReviewsByTaskId(tempDb.database, "TASK-001");
      expect(reviews).toHaveLength(2);
      expect(reviews[0].runNumber).toBe(1);
      expect(reviews[1].runNumber).toBe(2);
    });
  });

  describe("listCompletedReviewsByTaskId", () => {
    it("returns only COMPLETED reviews", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 2,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      const completed = listCompletedReviewsByTaskId(tempDb.database, "TASK-001");
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe("rev-001");
    });
  });

  describe("getCompletedReviewForTaskAndReviewNumber", () => {
    it("returns null when no completed review", () => {
      tempDb = createTempDatabase();
      expect(getCompletedReviewForTaskAndReviewNumber(tempDb.database, "TASK-001", 1)).toBeNull();
    });

    it("returns the completed review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      const completed = getCompletedReviewForTaskAndReviewNumber(tempDb.database, "TASK-001", 1);
      expect(completed).not.toBeNull();
      expect(completed!.verdict).toBe("APPROVED");
    });
  });

  describe("getMaxReviewNumberForTask", () => {
    it("returns 0 for task with no reviews", () => {
      tempDb = createTempDatabase();
      expect(getMaxReviewNumberForTask(tempDb.database, "TASK-001")).toBe(0);
    });

    it("returns the max review number", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 3,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      expect(getMaxReviewNumberForTask(tempDb.database, "TASK-001")).toBe(3);
    });
  });

  describe("getMaxRunNumberForReview", () => {
    it("returns 0 for review with no runs", () => {
      tempDb = createTempDatabase();
      expect(getMaxRunNumberForReview(tempDb.database, "TASK-001", 1)).toBe(0);
    });

    it("returns the max run number for a review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned_claim");

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 3,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      expect(getMaxRunNumberForReview(tempDb.database, "TASK-001", 1)).toBe(3);
    });
  });

  describe("uniqueness constraints", () => {
    it("allows same reviewNumber with different runNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      discardTaskReview(tempDb.database, "rev-001", CLAIM_A, "orphaned_claim");

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 1,
        runNumber: 2,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      const reviews = listTaskReviewsByTaskId(tempDb.database, "TASK-001");
      expect(reviews).toHaveLength(2);
    });

    it("allows multiple COMPLETED reviews for different reviewNumbers", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      completeTaskReview(tempDb.database, "rev-001", CLAIM_A, {
        verdict: "APPROVED",
        summary: "ok",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      createTaskReview(tempDb.database, {
        id: "rev-002",
        taskId: "TASK-001",
        reviewNumber: 2,
        runNumber: 1,
        reviewerClaimJson: CLAIM_A,
        snapshotWorkspaceId: "ws-002",
        snapshotBaseCommit: "base456",
        snapshotHeadCommit: "head789",
        snapshotFingerprint: "fp012",
      });

      completeTaskReview(tempDb.database, "rev-002", CLAIM_A, {
        verdict: "REVISION_REQUIRED",
        summary: "needs work",
        findingsJson: "[]",
        requiredChangesJson: "[]",
      });

      const completed = listCompletedReviewsByTaskId(tempDb.database, "TASK-001");
      expect(completed).toHaveLength(2);
    });
  });

  describe("foreign key", () => {
    it("ON DELETE CASCADE removes reviews when task is deleted", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);

      insertRunningReview(tempDb.database, { reviewerClaimJson: CLAIM_A });

      expect(getTaskReviewById(tempDb.database, "rev-001")).not.toBeNull();

      tempDb.database.prepare("DELETE FROM tasks WHERE id = ?").run("TASK-001");

      expect(getTaskReviewById(tempDb.database, "rev-001")).toBeNull();
    });
  });
});
