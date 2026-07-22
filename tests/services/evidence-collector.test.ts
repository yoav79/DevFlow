import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import type {
  EvidenceFile,
  EvidenceBundleBody,
} from "../../src/schemas/evidence-bundle-schema.js";
import type { DeterministicRevisionResult } from "../../src/services/deterministic-revision-result.js";
import type { ChangedFile, GitFileMode } from "../../src/services/git-change-detector.js";
import { GitChangeDetectionError } from "../../src/services/git-change-detector.js";
import {
  collectEvidenceBundle,
  EvidenceCollectorError,
  type EvidenceCollectorDeps,
} from "../../src/services/evidence-collector.js";
import { EvidenceFileCollectorError } from "../../src/services/evidence-file-collector.js";
import { EvidenceBundleError } from "../../src/services/evidence-bundle-service.js";
import { ReviewerClaimError } from "../../src/services/reviewer-claim-service.js";
import type { ReviewerEvidenceSnapshot } from "../../src/services/reviewer-claim-service.js";
import { WorkspaceFingerprintError } from "../../src/services/workspace-fingerprint.js";
import type { WorkspaceFingerprint } from "../../src/services/workspace-fingerprint.js";
import { PersistedTaskContractError } from "../../src/repositories/task-repository.js";
import type { TaskReview } from "../../src/types.js";
import type { ReviewerResult } from "../../src/schemas/reviewer-result-schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const H40 = "a".repeat(40);
const H40_B = "b".repeat(40);
const H40_C = "d".repeat(40);
const H64 = "c".repeat(64);
const H64_B = "e".repeat(64);

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function buildSnapshot(overrides: Partial<ReviewerEvidenceSnapshot> = {}): ReviewerEvidenceSnapshot {
  return {
    taskId: "task-1",
    projectId: "project-1",
    reviewId: "review-1",
    reviewNumber: 1,
    runNumber: 1,
    reviewStatus: "RUNNING",
    reviewerClaimJson: "claim-json-1",
    snapshotWorkspaceId: "workspace-1",
    snapshotBaseCommit: H40,
    snapshotHeadCommit: H40_B,
    snapshotFingerprint: H64,
    taskState: "REVIEWING",
    contractJson: JSON.stringify({
      objective: "Implement feature",
      context: "Need to implement",
      acceptanceCriteria: ["Works correctly"],
      allowedPaths: ["src/**"],
      forbiddenPaths: ["node_modules/**"],
      requiredCommands: [],
      assumptions: [],
      risks: [],
      status: "APPROVED",
    }),
    currentRevisionJson: JSON.stringify({
      status: "REVIEWING",
      taskId: "task-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      baseCommit: H40,
      changedFiles: [],
      pathValidation: { passed: true, violations: [] },
      commandsResult: null,
    }),
    workspaceId: "workspace-1",
    workspaceTaskId: "task-1",
    workspacePath: "/repo/work",
    workspaceBaseCommit: H40,
    workspaceStatus: "READY",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint builder
// ---------------------------------------------------------------------------

function buildFingerprint(overrides: Partial<WorkspaceFingerprint> = {}): WorkspaceFingerprint {
  return {
    workspaceId: "workspace-1",
    baseCommit: H40,
    headCommit: H40_B,
    workingTreeFingerprint: H64,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Changed file builders
// ---------------------------------------------------------------------------

function addedFile(path = "src/new.ts", currentMode: GitFileMode = "100644"): ChangedFile {
  return { status: "ADDED", path, currentMode };
}

function modifiedFile(
  path = "src/existing.ts",
  previousMode: GitFileMode = "100644",
  currentMode: GitFileMode = "100644",
): ChangedFile {
  return { status: "MODIFIED", path, previousMode, currentMode, previousObjectId: H40_C };
}

function deletedFile(path = "src/deleted.ts", previousMode: GitFileMode = "100644"): ChangedFile {
  return { status: "DELETED", path, previousMode, previousObjectId: H40_C };
}

// ---------------------------------------------------------------------------
// Evidence file builder
// ---------------------------------------------------------------------------

function textAddedFile(path = "src/new.ts"): EvidenceFile {
  return {
    fileKind: "TEXT",
    status: "ADDED",
    path,
    currentMode: "100644",
    currentContent: "new content",
    currentHash: hash("new content"),
    currentByteLength: Buffer.byteLength("new content", "utf8"),
    currentLineCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Previous review builder
// ---------------------------------------------------------------------------

function completedReview(overrides: Partial<TaskReview> = {}): TaskReview {
  const findings: ReviewerResult["findings"] = [
    {
      code: "FINDING-1",
      severity: "MEDIUM",
      title: "Issue found",
      description: "Description of issue",
    },
  ];
  const requiredChanges: ReviewerResult["requiredChanges"] = [
    {
      code: "RC-1",
      description: "Fix the issue",
      acceptanceCriteria: ["Issue is fixed"],
      relatedFindingCodes: ["FINDING-1"],
    },
  ];
  return {
    id: "review-prev",
    taskId: "task-1",
    reviewNumber: 1,
    runNumber: 1,
    status: "COMPLETED",
    reviewerClaimJson: null,
    snapshotWorkspaceId: null,
    snapshotBaseCommit: null,
    snapshotHeadCommit: null,
    snapshotFingerprint: null,
    verdict: "REVISION_REQUIRED",
    summary: "Previous review summary",
    findingsJson: JSON.stringify(findings),
    requiredChangesJson: JSON.stringify(requiredChanges),
    discardReason: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    completedAt: "2025-01-01T00:01:00.000Z",
    discardedAt: null,
    ...overrides,
  };
}

function approvedReview(): TaskReview {
  return completedReview({
    id: "review-approved",
    reviewNumber: 1,
    verdict: "APPROVED",
    summary: "Looks good",
    findingsJson: "[]",
    requiredChangesJson: "[]",
  });
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<EvidenceCollectorDeps> = {}): EvidenceCollectorDeps {
  return {
    loadSnapshot: vi.fn(),
    assertSnapshotStillOwned: vi.fn(),
    computeFingerprint: vi.fn(),
    detectChanges: vi.fn(),
    collectFiles: vi.fn(),
    createBundle: vi.fn(),
    listCompletedReviews: vi.fn(),
    getTaskContract: vi.fn(),
    readPreviousBlobBytes: vi.fn(),
    readPreviousSymlinkTarget: vi.fn(),
    readPatch: vi.fn(),
    ...overrides,
  };
}

function buildMockDeps(overrides: Partial<EvidenceCollectorDeps> = {}): EvidenceCollectorDeps {
  const snapshot = buildSnapshot();
  const fingerprint = buildFingerprint();
  const detectionResult = { changedFiles: [] as readonly ChangedFile[] };
  const evidenceFiles: readonly EvidenceFile[] = [];
  const bundle = { body: {}, bundleDigest: H64 };

  const defaultGetTaskContract = vi.fn().mockReturnValue({
    classification: "EXECUTABLE_TASK",
    objective: "Implement feature",
    context: "Need to implement",
    acceptanceCriteria: ["Works correctly"],
    allowedPaths: ["src/**"],
    forbiddenPaths: ["node_modules/**"],
    requiredCommands: [],
    assumptions: [],
    risks: [],
    openQuestions: [],
  });

  return {
    loadSnapshot: vi.fn().mockReturnValue(snapshot),
    assertSnapshotStillOwned: vi.fn(),
    computeFingerprint: vi.fn().mockReturnValue(fingerprint),
    detectChanges: vi.fn().mockReturnValue(detectionResult),
    collectFiles: vi.fn().mockReturnValue(evidenceFiles),
    createBundle: vi.fn().mockReturnValue(bundle),
    listCompletedReviews: vi.fn().mockReturnValue([]),
    getTaskContract: defaultGetTaskContract,
    readPreviousBlobBytes: vi.fn(),
    readPreviousSymlinkTarget: vi.fn(),
    readPatch: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function expectCollectorError(
  fn: () => void,
  code: string,
): void {
  try {
    fn();
    expect.fail("Expected EvidenceCollectorError");
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceCollectorError);
    expect((error as EvidenceCollectorError).code).toBe(code);
  }
}

function runGit(workspacePath: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

function withTempGitRepo<T>(fn: (workspacePath: string) => T): T {
  const workspacePath = mkdtempSync(join(tmpdir(), "devflow-evidence-collector-"));
  try {
    runGit(workspacePath, ["init"]);
    runGit(workspacePath, ["config", "user.name", "DevFlow Test"]);
    runGit(workspacePath, ["config", "user.email", "devflow@example.test"]);
    return fn(workspacePath);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

function commitAll(workspacePath: string, message: string): string {
  runGit(workspacePath, ["add", "."]);
  runGit(workspacePath, ["commit", "-m", message]);
  return runGit(workspacePath, ["rev-parse", "HEAD"]);
}

function revisionJson(baseCommit: string, changedFiles: readonly ChangedFile[]): string {
  return JSON.stringify({
    status: "REVIEWING",
    taskId: "task-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    baseCommit,
    changedFiles,
    pathValidation: { passed: true, violations: [] },
    commandsResult: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectEvidenceBundle", () => {
  describe("happy paths", () => {
    it("returns bundle with zero changed files", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
      expect(result.bundleDigest).toBe(H64);
      expect(deps.loadSnapshot).toHaveBeenCalledOnce();
      expect(deps.computeFingerprint).toHaveBeenCalledTimes(2);
      expect(deps.detectChanges).toHaveBeenCalledOnce();
      expect(deps.collectFiles).toHaveBeenCalledOnce();
      expect(deps.createBundle).toHaveBeenCalledOnce();
      expect(deps.assertSnapshotStillOwned).toHaveBeenCalledOnce();
    });

    it("returns bundle with multiple changed files", () => {
      const changedFiles = [addedFile("a.ts"), modifiedFile("b.ts")];
      const evidenceFiles: EvidenceFile[] = [textAddedFile("a.ts")];

      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles,
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });

      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles }),
        collectFiles: vi.fn().mockReturnValue(evidenceFiles),
      });

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
      const collectFilesCall = deps.collectFiles.mock.calls[0]!;
      expect(collectFilesCall[0]).toEqual(expect.objectContaining({ changedFiles }));
      expect(typeof collectFilesCall[1]?.readPatch).toBe("function");
    });

    it("returns bundle with empty previousCorrections when no completed reviews", () => {
      const deps = buildMockDeps({
        listCompletedReviews: vi.fn().mockReturnValue([]),
      });

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.previousCorrections).toEqual([]);
    });

    it("returns bundle with multiple previous corrections", () => {
      const review1 = completedReview({
        reviewNumber: 1,
        id: "review-1-prev",
      });
      const review2 = completedReview({
        reviewNumber: 2,
        id: "review-2-prev",
      });

      const snapshot = buildSnapshot({ reviewNumber: 3 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review1, review2]),
      });

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-3",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.previousCorrections).toHaveLength(2);
    });

    it("returns bundle with REVIEWING deterministic revision", () => {
      const deps = buildMockDeps();

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.deterministicRevision.status).toBe("REVIEWING");
    });

    it("returns bundle with REVISION_REQUIRED deterministic revision", () => {
      const revisionJson = JSON.stringify({
        status: "REVISION_REQUIRED",
        taskId: "task-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        baseCommit: H40,
        changedFiles: [],
        pathValidation: {
          passed: false,
          violations: [{
            path: "src/bad.ts",
            status: "MODIFIED",
            code: "FORBIDDEN",
            message: "Path forbidden",
          }],
        },
        commandsResult: null,
      });

      const snapshot = buildSnapshot({ currentRevisionJson: revisionJson });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.deterministicRevision.status).toBe("REVISION_REQUIRED");
    });
  });

  describe("integration call counts", () => {
    it("calls each dependency exactly once", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(deps.loadSnapshot).toHaveBeenCalledTimes(1);
      expect(deps.assertSnapshotStillOwned).toHaveBeenCalledTimes(1);
      expect(deps.detectChanges).toHaveBeenCalledTimes(1);
      expect(deps.collectFiles).toHaveBeenCalledTimes(1);
      expect(deps.createBundle).toHaveBeenCalledTimes(1);
      expect(deps.listCompletedReviews).toHaveBeenCalledTimes(1);
    });

    it("calls computeFingerprint exactly twice", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(deps.computeFingerprint).toHaveBeenCalledTimes(2);
    });

    it("passes correct arguments to loadSnapshot", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(deps.loadSnapshot).toHaveBeenCalledWith(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      });
    });

    it("passes correct arguments to computeFingerprint", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(deps.computeFingerprint).toHaveBeenCalledWith({
        workspacePath: "/repo/work",
        workspaceId: "workspace-1",
        baseCommit: H40,
      });
    });

    it("passes correct arguments to detectChanges", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(deps.detectChanges).toHaveBeenCalledWith("/repo/work", H40);
    });

    it("passes correct arguments to collectFiles", () => {
      const changedFiles = [addedFile()];
      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles,
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles }),
      });
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const collectFilesCall = deps.collectFiles.mock.calls[0]!;
      expect(collectFilesCall[0]).toEqual({
        workspacePath: "/repo/work",
        baseCommit: H40,
        changedFiles,
      });
      expect(typeof collectFilesCall[1]?.readPreviousBlobBytes).toBe("function");
      expect(typeof collectFilesCall[1]?.readPreviousSymlinkTarget).toBe("function");
      expect(typeof collectFilesCall[1]?.readPatch).toBe("function");
    });
  });

  describe("snapshot stability failures", () => {
    it("throws HEAD_COMMIT_MISMATCH when initial fingerprint headCommit differs", () => {
      const snapshot = buildSnapshot({ snapshotHeadCommit: H40_B });
      const fingerprint = buildFingerprint({ headCommit: H40_C });

      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        computeFingerprint: vi.fn().mockReturnValue(fingerprint),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "HEAD_COMMIT_MISMATCH",
      );
    });

    it("throws WORKSPACE_CHANGED_DURING_COLLECTION when initial fingerprint differs", () => {
      const snapshot = buildSnapshot({ snapshotFingerprint: H64 });
      const fingerprint = buildFingerprint({ workingTreeFingerprint: H64_B });

      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        computeFingerprint: vi.fn().mockReturnValue(fingerprint),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "WORKSPACE_CHANGED_DURING_COLLECTION",
      );
    });

    it("throws WORKSPACE_CHANGED_DURING_COLLECTION when final fingerprint differs", () => {
      const snapshot = buildSnapshot();
      let callCount = 0;
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        computeFingerprint: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return buildFingerprint();
          }
          return buildFingerprint({ workingTreeFingerprint: H64_B });
        }),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "WORKSPACE_CHANGED_DURING_COLLECTION",
      );
    });

    it("throws HEAD_COMMIT_MISMATCH when final headCommit differs", () => {
      const snapshot = buildSnapshot();
      let callCount = 0;
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        computeFingerprint: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return buildFingerprint();
          }
          return buildFingerprint({ headCommit: H40_C });
        }),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "WORKSPACE_CHANGED_DURING_COLLECTION",
      );
    });
  });

  describe("previous correction edge cases", () => {
    it("throws PREVIOUS_REVIEW_INVALID when reviewNumber >= current reviewNumber", () => {
      const review1 = completedReview({ reviewNumber: 2 });
      const review2 = completedReview({ reviewNumber: 3 });

      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review1, review2]),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("includes only reviews with reviewNumber < current reviewNumber", () => {
      const review1 = completedReview({ reviewNumber: 1 });
      const review2 = completedReview({ reviewNumber: 2 });

      const snapshot = buildSnapshot({ reviewNumber: 3 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review1, review2]),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-3",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.previousCorrections).toHaveLength(2);
    });

    it("detects duplicate reviewNumber and throws DUPLICATE_REVIEW_NUMBER", () => {
      const review1 = completedReview({ reviewNumber: 1, id: "r1" });
      const review2 = completedReview({ reviewNumber: 1, id: "r2" });

      const snapshot = buildSnapshot({ reviewNumber: 3 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review1, review2]),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-3",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DUPLICATE_REVIEW_NUMBER",
      );
    });

    it("throws PREVIOUS_REVIEW_APPROVED when APPROVED review exists", () => {
      const rev1 = completedReview({
        reviewNumber: 1,
        verdict: "REVISION_REQUIRED",
        id: "rev-1",
      });
      const rev2 = approvedReview();
      rev2.reviewNumber = 2;
      rev2.id = "rev-2";
      const rev3 = completedReview({
        reviewNumber: 3,
        verdict: "REVISION_REQUIRED",
        id: "rev-3",
      });

      const snapshot = buildSnapshot({ reviewNumber: 4 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([rev1, rev2, rev3]),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-4",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_APPROVED",
      );
    });
  });

  describe("contract and revision invalidity", () => {
    it("throws CONTRACT_INVALID when getTaskContract throws PersistedTaskContractError", () => {
      const deps = buildMockDeps({
        getTaskContract: vi.fn().mockImplementation(() => {
          throw new PersistedTaskContractError("task-1", "JSON inválido.");
        }),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "CONTRACT_INVALID",
      );
    });

    it("throws CONTRACT_NOT_APPROVED when getTaskContract returns null", () => {
      const deps = buildMockDeps({
        getTaskContract: vi.fn().mockReturnValue(null),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "CONTRACT_NOT_APPROVED",
      );
    });

    it("throws CONTRACT_INVALID when getTaskContract throws generic Error", () => {
      const original = new Error("No existe la tarea: task-1");
      const deps = buildMockDeps({
        getTaskContract: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      try {
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
        expect.fail("Expected EvidenceCollectorError");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceCollectorError);
        expect((error as EvidenceCollectorError).code).toBe("CONTRACT_INVALID");
        expect((error as EvidenceCollectorError).cause).toBe(original);
      }
    });

    it("calls getTaskContract exactly once with database and taskId", () => {
      const getTaskContractMock = vi.fn().mockReturnValue({
        classification: "EXECUTABLE_TASK",
        objective: "Test",
        context: "Test",
        acceptanceCriteria: ["AC1"],
        allowedPaths: [],
        forbiddenPaths: [],
        requiredCommands: [],
        assumptions: [],
        risks: [],
        openQuestions: [],
      });
      const deps = buildMockDeps({
        getTaskContract: getTaskContractMock,
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(getTaskContractMock).toHaveBeenCalledOnce();
      expect(getTaskContractMock).toHaveBeenCalledWith(db, "task-1");
    });

    it("throws CONTRACT_INVALID when snapshot taskId differs from input taskId", () => {
      const snapshot = buildSnapshot({
        taskId: "other-task",
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "other-task",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles: [],
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "CONTRACT_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when currentRevisionJson is not valid JSON", () => {
      const snapshot = buildSnapshot({ currentRevisionJson: "not-json" });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when taskId does not match", () => {
      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "wrong-task",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles: [],
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when projectId does not match", () => {
      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "wrong-project",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles: [],
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when workspaceId does not match", () => {
      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "project-1",
          workspaceId: "wrong-workspace",
          baseCommit: H40,
          changedFiles: [],
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when baseCommit does not match", () => {
      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40_C,
          changedFiles: [],
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when pathValidation is missing", () => {
      const snapshot = buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles: [],
        }),
      });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });
  });

  describe("error preservation", () => {
    it("preserves ReviewerClaimError from loadSnapshot without remapping", () => {
      const original = new ReviewerClaimError("claim failed", {
        code: "REVIEWER_EVIDENCE_REVIEW_NOT_FOUND",
        taskId: "task-1",
        reviewId: "review-1",
      });

      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      try {
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
        expect.fail("Expected ReviewerClaimError");
      } catch (error) {
        expect(error).toBe(original);
        expect(error).toBeInstanceOf(ReviewerClaimError);
      }
    });

    it("preserves EvidenceFileCollectorError from collectFiles without remapping", () => {
      const original = new EvidenceFileCollectorError("file collection failed", {
        code: "FILE_MISSING",
      });

      const deps = buildMockDeps({
        collectFiles: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      try {
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
        expect.fail("Expected EvidenceFileCollectorError");
      } catch (error) {
        expect(error).toBe(original);
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
      }
    });

    it("preserves EvidenceBundleError from createBundle without remapping", () => {
      const original = new EvidenceBundleError("bundle creation failed", {
        code: "EVIDENCE_BUNDLE_TOO_LARGE",
      });

      const deps = buildMockDeps({
        createBundle: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      try {
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
        expect.fail("Expected EvidenceBundleError");
      } catch (error) {
        expect(error).toBe(original);
        expect(error).toBeInstanceOf(EvidenceBundleError);
      }
    });

    it("maps GitChangeDetectionError to EvidenceCollectorError with GIT_DETECTION_FAILED", () => {
      const original = new GitChangeDetectionError("git failed", {
        code: "GIT_COMMAND_FAILED",
      });

      const deps = buildMockDeps({
        detectChanges: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "GIT_DETECTION_FAILED",
      );
    });

    it("maps SyntaxError to EvidenceCollectorError with DETERMINISTIC_REVISION_INVALID", () => {
      const original = new SyntaxError("Unexpected token");

      const deps = buildMockDeps({
        listCompletedReviews: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("maps WorkspaceFingerprintError to EvidenceCollectorError with WORKSPACE_CHANGED_DURING_COLLECTION", () => {
      const original = new WorkspaceFingerprintError("fingerprint failed", {
        code: "WORKSPACE_FINGERPRINT_GIT_FAILED",
      });

      const deps = buildMockDeps({
        computeFingerprint: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "WORKSPACE_CHANGED_DURING_COLLECTION",
      );
    });
  });

  describe("read-only semantics", () => {
    it("calls assertSnapshotStillOwned after createBundle", () => {
      const callOrder: string[] = [];
      const deps = buildMockDeps({
        createBundle: vi.fn().mockImplementation(() => {
          callOrder.push("createBundle");
          return { body: {}, bundleDigest: H64 };
        }),
        assertSnapshotStillOwned: vi.fn().mockImplementation(() => {
          callOrder.push("assertSnapshotStillOwned");
        }),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(callOrder).toEqual(["createBundle", "assertSnapshotStillOwned"]);
    });

    it("throws ReviewerClaimError when assertSnapshotStillOwned fails", () => {
      const original = new ReviewerClaimError("ownership lost", {
        code: "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED",
        taskId: "task-1",
        reviewId: "review-1",
      });

      const deps = buildMockDeps({
        assertSnapshotStillOwned: vi.fn().mockImplementation(() => {
          throw original;
        }),
      });

      const db = {} as never;

      try {
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
        expect.fail("Expected ReviewerClaimError");
      } catch (error) {
        expect(error).toBe(original);
        expect(error).toBeInstanceOf(ReviewerClaimError);
      }
    });

    it("does not return bundle when assertSnapshotStillOwned fails", () => {
      const deps = buildMockDeps({
        assertSnapshotStillOwned: vi.fn().mockImplementation(() => {
          throw new ReviewerClaimError("ownership lost", {
            code: "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED",
          });
        }),
      });

      const db = {} as never;

      try {
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
        expect.fail("Expected ReviewerClaimError");
      } catch {
        expect(deps.createBundle).toHaveBeenCalled();
      }
    });
  });

  describe("input validation", () => {
    it("throws INVALID_INPUT when taskId is empty", () => {
      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }),
        "INVALID_INPUT",
      );
    });

    it("throws INVALID_INPUT when reviewId is empty", () => {
      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "",
          expectedReviewerClaimJson: "claim-json-1",
        }),
        "INVALID_INPUT",
      );
    });

    it("throws INVALID_INPUT when expectedReviewerClaimJson is empty", () => {
      const db = {} as never;

      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "",
        }),
        "INVALID_INPUT",
      );
    });
  });

  describe("deterministic revision evidence mapping", () => {
    it("maps pathValidation correctly", () => {
      const revisionJson = JSON.stringify({
        status: "REVIEWING",
        taskId: "task-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        baseCommit: H40,
        changedFiles: [],
        pathValidation: {
          passed: true,
          violations: [],
        },
        commandsResult: null,
      });

      const snapshot = buildSnapshot({ currentRevisionJson: revisionJson });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.deterministicRevision.pathValidation).toEqual({
        passed: true,
        violations: [],
      });
    });

    it("maps commandsResult correctly when non-null", () => {
      const revisionJson = JSON.stringify({
        status: "REVIEWING",
        taskId: "task-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        baseCommit: H40,
        changedFiles: [],
        pathValidation: { passed: true, violations: [] },
        commandsResult: {
          results: [{
            command: "npm test",
            exitCode: 0,
            signal: null,
            stdout: "all tests passed",
            stderr: "",
            timedOut: false,
            aborted: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            passed: true,
          }],
          passed: true,
          stoppedAtIndex: null,
        },
      });

      const snapshot = buildSnapshot({ currentRevisionJson: revisionJson });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.deterministicRevision.commandsResult).not.toBeNull();
      expect(bundleBodyArg.deterministicRevision.commandsResult!.passed).toBe(true);
    });
  });

  describe("approved contract evidence mapping", () => {
    it("maps all contract fields correctly", () => {
      const deps = buildMockDeps({
        getTaskContract: vi.fn().mockReturnValue({
          classification: "EXECUTABLE_TASK",
          objective: "Build feature X",
          context: "Context details",
          acceptanceCriteria: ["AC1", "AC2"],
          allowedPaths: ["src/**"],
          forbiddenPaths: ["dist/**"],
          requiredCommands: ["npm test"],
          assumptions: ["Assumption 1"],
          risks: ["Risk 1"],
          openQuestions: [],
        }),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.approvedContract).toEqual({
        objective: "Build feature X",
        context: "Context details",
        acceptanceCriteria: ["AC1", "AC2"],
        allowedPaths: ["src/**"],
        forbiddenPaths: ["dist/**"],
        requiredCommands: ["npm test"],
        assumptions: ["Assumption 1"],
        risks: ["Risk 1"],
      });
    });
  });

  describe("error class properties", () => {
    it("has correct name and code properties", () => {
      const error = new EvidenceCollectorError("test", { code: "INVALID_INPUT" });
      expect(error.name).toBe("EvidenceCollectorError");
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe("test");
    });

    it("has frozen details when provided", () => {
      const details = { key: "value" };
      const error = new EvidenceCollectorError("test", {
        code: "INVALID_INPUT",
        details,
      });
      expect(error.details).toEqual(details);
      expect(() => {
        (error.details as Record<string, unknown>).key = "changed";
      }).toThrow();
    });

    it("has undefined details when not provided", () => {
      const error = new EvidenceCollectorError("test", { code: "INVALID_INPUT" });
      expect(error.details).toBeUndefined();
    });

    it("preserves cause when provided", () => {
      const cause = new Error("original");
      const error = new EvidenceCollectorError("test", {
        code: "INVALID_INPUT",
        cause,
      });
      expect(error.cause).toBe(cause);
    });
  });

  describe("bundle body construction", () => {
    it("uses version 1", () => {
      const deps = buildMockDeps();
      const db = {} as never;

      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.version).toBe(1);
    });

    it("uses snapshot baseCommit and headCommit", () => {
      const snapshot = buildSnapshot({
        snapshotBaseCommit: H40,
        snapshotHeadCommit: H40_B,
      });

      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.baseCommit).toBe(H40);
      expect(bundleBodyArg.headCommit).toBe(H40_B);
    });

    it("uses snapshot fingerprint", () => {
      const snapshot = buildSnapshot({
        snapshotFingerprint: H64,
      });

      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.workspaceFingerprint).toBe(H64);
    });
  });

  describe("read-only contract assertion", () => {
    it("throws INVALID_INPUT when database is null", () => {
      expectCollectorError(
        () => collectEvidenceBundle(null, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }),
        "INVALID_INPUT",
      );
    });

    it("throws INVALID_INPUT when database is undefined", () => {
      expectCollectorError(
        () => collectEvidenceBundle(undefined as never, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }),
        "INVALID_INPUT",
      );
    });
  });

  describe("changedFiles structural comparison", () => {
    function snapshotWithChangedFiles(changedFiles: readonly ChangedFile[]) {
      return buildSnapshot({
        currentRevisionJson: JSON.stringify({
          status: "REVIEWING",
          taskId: "task-1",
          projectId: "project-1",
          workspaceId: "workspace-1",
          baseCommit: H40,
          changedFiles,
          pathValidation: { passed: true, violations: [] },
          commandsResult: null,
        }),
      });
    }

    it("passes when changedFiles match exactly", () => {
      const files = [addedFile("a.ts"), modifiedFile("b.ts")];
      const snapshot = snapshotWithChangedFiles(files);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: files }),
      });

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
    });

    it("throws DETERMINISTIC_REVISION_INVALID when count differs (extra file)", () => {
      const snapshotFiles = [addedFile("a.ts")];
      const detectFiles = [addedFile("a.ts"), modifiedFile("b.ts")];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws DETERMINISTIC_REVISION_INVALID when count differs (missing file)", () => {
      const snapshotFiles = [addedFile("a.ts"), modifiedFile("b.ts")];
      const detectFiles = [addedFile("a.ts")];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws when status differs", () => {
      const snapshotFiles: ChangedFile[] = [{ status: "ADDED", path: "a.ts", currentMode: "100644" }];
      const detectFiles: ChangedFile[] = [{ status: "MODIFIED", path: "a.ts", previousMode: "100644", currentMode: "100644", previousObjectId: H40_C }];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws when path differs", () => {
      const snapshotFiles: ChangedFile[] = [{ status: "ADDED", path: "a.ts", currentMode: "100644" }];
      const detectFiles: ChangedFile[] = [{ status: "ADDED", path: "b.ts", currentMode: "100644" }];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws when previousPath differs for RENAMED", () => {
      const snapshotFiles: ChangedFile[] = [{
        status: "RENAMED", path: "new.ts", previousPath: "old.ts",
        previousMode: "100644", currentMode: "100644",
        previousObjectId: H40_C, similarityScore: 100,
      }];
      const detectFiles: ChangedFile[] = [{
        status: "RENAMED", path: "new.ts", previousPath: "different.ts",
        previousMode: "100644", currentMode: "100644",
        previousObjectId: H40_C, similarityScore: 100,
      }];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws when mode differs for MODIFIED", () => {
      const snapshotFiles: ChangedFile[] = [{
        status: "MODIFIED", path: "a.ts",
        previousMode: "100644", currentMode: "100644", previousObjectId: H40_C,
      }];
      const detectFiles: ChangedFile[] = [{
        status: "MODIFIED", path: "a.ts",
        previousMode: "100644", currentMode: "100755", previousObjectId: H40_C,
      }];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws when previousObjectId differs for MODIFIED", () => {
      const snapshotFiles: ChangedFile[] = [{
        status: "MODIFIED", path: "a.ts",
        previousMode: "100644", currentMode: "100644", previousObjectId: H40_C,
      }];
      const detectFiles: ChangedFile[] = [{
        status: "MODIFIED", path: "a.ts",
        previousMode: "100644", currentMode: "100644", previousObjectId: "f".repeat(40),
      }];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("throws when similarityScore differs for RENAMED", () => {
      const snapshotFiles: ChangedFile[] = [{
        status: "RENAMED", path: "new.ts", previousPath: "old.ts",
        previousMode: "100644", currentMode: "100644",
        previousObjectId: H40_C, similarityScore: 100,
      }];
      const detectFiles: ChangedFile[] = [{
        status: "RENAMED", path: "new.ts", previousPath: "old.ts",
        previousMode: "100644", currentMode: "100644",
        previousObjectId: H40_C, similarityScore: 80,
      }];
      const snapshot = snapshotWithChangedFiles(snapshotFiles);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: detectFiles }),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "DETERMINISTIC_REVISION_INVALID",
      );
    });

    it("passes when RENAMED fields match exactly", () => {
      const files: ChangedFile[] = [{
        status: "RENAMED", path: "new.ts", previousPath: "old.ts",
        previousMode: "100644", currentMode: "100644",
        previousObjectId: H40_C, similarityScore: 100,
      }];
      const snapshot = snapshotWithChangedFiles(files);
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        detectChanges: vi.fn().mockReturnValue({ changedFiles: files }),
      });

      const db = {} as never;
      const result = collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-1",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      expect(result).toBeDefined();
    });
  });

  describe("previous corrections detailed", () => {
    it("throws when reviewNumber equals current reviewNumber", () => {
      const review = completedReview({ reviewNumber: 1 });
      const snapshot = buildSnapshot({ reviewNumber: 1 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("throws when reviewNumber greater than current", () => {
      const review = completedReview({ reviewNumber: 5 });
      const snapshot = buildSnapshot({ reviewNumber: 3 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-3",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("includes valid REVISION_REQUIRED corrections in ascending order", () => {
      const review1 = completedReview({ reviewNumber: 1 });
      const review2 = completedReview({ reviewNumber: 2 });
      const snapshot = buildSnapshot({ reviewNumber: 3 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review2, review1]),
      });

      const db = {} as never;
      collectEvidenceBundle(db, {
        taskId: "task-1",
        reviewId: "review-3",
        expectedReviewerClaimJson: "claim-json-1",
      }, deps);

      const bundleBodyArg = deps.createBundle.mock.calls[0][0] as EvidenceBundleBody;
      expect(bundleBodyArg.previousCorrections).toHaveLength(2);
      expect(bundleBodyArg.previousCorrections[0]!.reviewNumber).toBe(1);
      expect(bundleBodyArg.previousCorrections[1]!.reviewNumber).toBe(2);
    });

    it("throws PREVIOUS_REVIEW_INVALID when findingsJson is corrupt", () => {
      const review = completedReview({
        reviewNumber: 1,
        findingsJson: "not-json",
      });
      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("throws PREVIOUS_REVIEW_INVALID when requiredChangesJson is corrupt", () => {
      const review = completedReview({
        reviewNumber: 1,
        requiredChangesJson: "not-json",
      });
      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("throws PREVIOUS_REVIEW_INVALID when findings are empty", () => {
      const review = completedReview({
        reviewNumber: 1,
        findingsJson: "[]",
      });
      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("throws PREVIOUS_REVIEW_INVALID when requiredChanges are empty", () => {
      const review = completedReview({
        reviewNumber: 1,
        requiredChangesJson: "[]",
      });
      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("throws PREVIOUS_REVIEW_INVALID when summary is invalid", () => {
      const review = completedReview({
        reviewNumber: 1,
        summary: "   ",
      });
      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });

    it("throws PREVIOUS_REVIEW_INVALID when a listed review is not COMPLETED", () => {
      const review = completedReview({
        reviewNumber: 1,
        status: "RUNNING",
      });
      const snapshot = buildSnapshot({ reviewNumber: 2 });
      const deps = buildMockDeps({
        loadSnapshot: vi.fn().mockReturnValue(snapshot),
        listCompletedReviews: vi.fn().mockReturnValue([review]),
      });

      const db = {} as never;
      expectCollectorError(
        () => collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-2",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps),
        "PREVIOUS_REVIEW_INVALID",
      );
    });
  });

  describe("default Git readers", () => {
    it("reads previous blob bytes by objectId, not path", () => {
      withTempGitRepo((workspacePath) => {
        const binary = Buffer.from([0, 1, 2, 255]);
        const blobPath = join(workspacePath, "blob.bin");
        writeFileSync(blobPath, binary);
        const objectId = runGit(workspacePath, ["hash-object", "-w", "blob.bin"]);

        const collectFiles: NonNullable<EvidenceCollectorDeps["collectFiles"]> = (_input, fileDeps) => {
          const reader = fileDeps!.readPreviousBlobBytes!;
          const result = reader(workspacePath, H40, "path/does/not/matter.bin", objectId);
          expect(result).toEqual(binary);
          return [];
        };

        const deps = buildMockDeps({
          collectFiles: vi.fn(collectFiles),
          readPreviousBlobBytes: undefined,
        });
        const db = {} as never;
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
      });
    });

    it("decodes previous symlink target by objectId as UTF-8", () => {
      withTempGitRepo((workspacePath) => {
        writeFileSync(join(workspacePath, "target.txt"), "../real-target\n", "utf8");
        const objectId = runGit(workspacePath, ["hash-object", "-w", "target.txt"]);

        const collectFiles: NonNullable<EvidenceCollectorDeps["collectFiles"]> = (_input, fileDeps) => {
          const reader = fileDeps!.readPreviousSymlinkTarget!;
          const result = reader(workspacePath, H40, "wrong-link", objectId);
          expect(result).toBe("../real-target\n");
          return [];
        };

        const deps = buildMockDeps({
          collectFiles: vi.fn(collectFiles),
          readPreviousSymlinkTarget: undefined,
        });
        const db = {} as never;
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
      });
    });

    it("fails closed and preserves exitCode when blob objectId is invalid", () => {
      withTempGitRepo((workspacePath) => {
        const collectFiles: NonNullable<EvidenceCollectorDeps["collectFiles"]> = (_input, fileDeps) => {
          const reader = fileDeps!.readPreviousBlobBytes!;
          reader(workspacePath, H40, "irrelevant.bin", "f".repeat(40));
          return [];
        };

        const deps = buildMockDeps({
          collectFiles: vi.fn(collectFiles),
          readPreviousBlobBytes: undefined,
        });
        const db = {} as never;

        try {
          collectEvidenceBundle(db, {
            taskId: "task-1",
            reviewId: "review-1",
            expectedReviewerClaimJson: "claim-json-1",
          }, deps);
          expect.fail("Expected EvidenceCollectorError");
        } catch (error) {
          expect(error).toBeInstanceOf(EvidenceCollectorError);
          expect((error as EvidenceCollectorError).code).toBe("GIT_DETECTION_FAILED");
          expect(typeof (error as EvidenceCollectorError).details?.["exitCode"]).toBe("number");
        }
      });
    });
  });

  describe("default readPatch", () => {
    it("reads non-empty patch for simple MODIFIED file", () => {
      withTempGitRepo((workspacePath) => {
        writeFileSync(join(workspacePath, "file.txt"), "before\n", "utf8");
        const baseCommit = commitAll(workspacePath, "base");
        writeFileSync(join(workspacePath, "file.txt"), "after\n", "utf8");
        const changedFiles = [modifiedFile("file.txt")];
        const snapshot = buildSnapshot({
          snapshotBaseCommit: baseCommit,
          currentRevisionJson: revisionJson(baseCommit, changedFiles),
          workspacePath,
        });

        const collectFiles: NonNullable<EvidenceCollectorDeps["collectFiles"]> = (_input, fileDeps) => {
          const patch = fileDeps!.readPatch!(workspacePath, baseCommit, "file.txt");
          expect(patch).toContain("diff --git");
          expect(patch).toContain("file.txt");
          return [];
        };

        const deps = buildMockDeps({
          loadSnapshot: vi.fn().mockReturnValue(snapshot),
          detectChanges: vi.fn().mockReturnValue({ changedFiles }),
          collectFiles: vi.fn(collectFiles),
          readPatch: undefined,
        });
        const db = {} as never;
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
      });
    });

    it("reads non-empty patch for RENAMED/MODIFIED with previousPath and current path", () => {
      withTempGitRepo((workspacePath) => {
        writeFileSync(join(workspacePath, "old.txt"), "before\n", "utf8");
        const baseCommit = commitAll(workspacePath, "base");
        runGit(workspacePath, ["mv", "old.txt", "new.txt"]);
        writeFileSync(join(workspacePath, "new.txt"), "after\n", "utf8");
        const changedFiles: ChangedFile[] = [{
          status: "RENAMED",
          path: "new.txt",
          previousPath: "old.txt",
          previousMode: "100644",
          currentMode: "100644",
          previousObjectId: H40_C,
          similarityScore: 50,
        }];
        const snapshot = buildSnapshot({
          snapshotBaseCommit: baseCommit,
          currentRevisionJson: revisionJson(baseCommit, changedFiles),
          workspacePath,
        });

        const collectFiles: NonNullable<EvidenceCollectorDeps["collectFiles"]> = (_input, fileDeps) => {
          const patch = fileDeps!.readPatch!(workspacePath, baseCommit, "new.txt", "old.txt");
          expect(patch).toContain("diff --git");
          expect(patch).toContain("old.txt");
          expect(patch).toContain("new.txt");
          return [];
        };

        const deps = buildMockDeps({
          loadSnapshot: vi.fn().mockReturnValue(snapshot),
          detectChanges: vi.fn().mockReturnValue({ changedFiles }),
          collectFiles: vi.fn(collectFiles),
          readPatch: undefined,
        });
        const db = {} as never;
        collectEvidenceBundle(db, {
          taskId: "task-1",
          reviewId: "review-1",
          expectedReviewerClaimJson: "claim-json-1",
        }, deps);
      });
    });

    it("fails closed when patch is empty", () => {
      withTempGitRepo((workspacePath) => {
        writeFileSync(join(workspacePath, "file.txt"), "same\n", "utf8");
        const baseCommit = commitAll(workspacePath, "base");
        const changedFiles = [modifiedFile("file.txt")];
        const snapshot = buildSnapshot({
          snapshotBaseCommit: baseCommit,
          currentRevisionJson: revisionJson(baseCommit, changedFiles),
          workspacePath,
        });

        const collectFiles: NonNullable<EvidenceCollectorDeps["collectFiles"]> = (_input, fileDeps) => {
          fileDeps!.readPatch!(workspacePath, baseCommit, "file.txt");
          return [];
        };

        const deps = buildMockDeps({
          loadSnapshot: vi.fn().mockReturnValue(snapshot),
          detectChanges: vi.fn().mockReturnValue({ changedFiles }),
          collectFiles: vi.fn(collectFiles),
          readPatch: undefined,
        });
        const db = {} as never;

        expectCollectorError(
          () => collectEvidenceBundle(db, {
            taskId: "task-1",
            reviewId: "review-1",
            expectedReviewerClaimJson: "claim-json-1",
          }, deps),
          "GIT_DETECTION_FAILED",
        );
      });
    });
  });
});
