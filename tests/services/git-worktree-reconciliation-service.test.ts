import { describe, expect, it } from "vitest";

import {
  planGitWorktreeReconciliation,
  type GitWorktreeReconciliationPlan,
} from "../../src/services/git-worktree-reconciliation-service.js";
import type { GitWorktreeInspectionResult } from "../../src/services/git-worktree-service.js";

function createInspection(
  overrides: Partial<GitWorktreeInspectionResult> = {},
): GitWorktreeInspectionResult {
  return {
    state: "COMPLETE",
    repositoryRoot: "/repo",
    baseCommit: "a".repeat(40),
    branchName: "devflow/project-a/TASK-001/execution-1",
    workspacePath: "/repo/worktrees/project-a/TASK-001/1",
    branchExists: true,
    pathKind: "DIRECTORY",
    worktreeRegistered: true,
    headMatchesBaseCommit: true,
    branchMatchesExpected: true,
    detached: false,
    locked: false,
    prunable: false,
    ...overrides,
  };
}

function expectPlan(
  inspection: GitWorktreeInspectionResult,
  expected: GitWorktreeReconciliationPlan,
): void {
  expect(planGitWorktreeReconciliation(inspection)).toEqual(expected);
}

describe("planGitWorktreeReconciliation", () => {
  describe("CLEAN", () => {
    it("returns NO_ACTION for a coherent clean state", () => {
      expectPlan(createInspection({
        state: "CLEAN",
        branchExists: false,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "NO_ACTION",
        reason: "ALREADY_CLEAN",
        automatic: true,
      });
    });

    it("blocks clean state with an existing branch", () => {
      expectPlan(createInspection({
        state: "CLEAN",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks clean state with a directory path", () => {
      expectPlan(createInspection({
        state: "CLEAN",
        branchExists: false,
        pathKind: "DIRECTORY",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks clean state with a registered worktree", () => {
      expectPlan(createInspection({
        state: "CLEAN",
        branchExists: false,
        pathKind: "MISSING",
        worktreeRegistered: true,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });
  });

  describe("COMPLETE", () => {
    it("returns NO_ACTION for a coherent complete state", () => {
      expectPlan(createInspection(), {
        action: "NO_ACTION",
        reason: "WORKTREE_COMPLETE",
        automatic: true,
      });
    });

    it("blocks complete state without branch", () => {
      expectPlan(createInspection({
        branchExists: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks complete state without registration", () => {
      expectPlan(createInspection({
        worktreeRegistered: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks complete state with HEAD mismatch", () => {
      expectPlan(createInspection({
        headMatchesBaseCommit: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks complete state with branch mismatch", () => {
      expectPlan(createInspection({
        branchMatchesExpected: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks detached complete state", () => {
      expectPlan(createInspection({
        detached: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks prunable complete state", () => {
      expectPlan(createInspection({
        prunable: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_PRUNABLE",
        automatic: false,
      });
    });

    it("locked has priority over complete", () => {
      expectPlan(createInspection({
        locked: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_LOCKED",
        automatic: false,
      });
    });
  });

  describe("ORPHAN_BRANCH", () => {
    it("returns REMOVE_BRANCH for a coherent orphan branch", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
        locked: false,
        prunable: false,
      }), {
        action: "REMOVE_BRANCH",
        reason: "ORPHAN_BRANCH",
        automatic: true,
      });
    });

    it("blocks orphan branch with directory path", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "DIRECTORY",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "PATH_REQUIRES_MANUAL_REVIEW",
        automatic: false,
      });
    });

    it("blocks orphan branch with registration", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: true,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "UNSUPPORTED_RECOVERABLE_STATE",
        automatic: false,
      });
    });

    it("blocks orphan branch when prunable", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
        prunable: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_PRUNABLE",
        automatic: false,
      });
    });

    it("blocks orphan branch when locked", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
        locked: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_LOCKED",
        automatic: false,
      });
    });
  });

  describe("PATHS", () => {
    it.each(["FILE", "SYMLINK"] as const)("%s requires manual review", (pathKind) => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind,
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "PATH_REQUIRES_MANUAL_REVIEW",
        automatic: false,
      });
    });

    it("directory that is not complete requires manual review", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "DIRECTORY",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "PATH_REQUIRES_MANUAL_REVIEW",
        automatic: false,
      });
    });
  });

  describe("PRUNABLE AND LOCKED", () => {
    it("prunable produces WORKTREE_PRUNABLE", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        prunable: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_PRUNABLE",
        automatic: false,
      });
    });

    it("locked produces WORKTREE_LOCKED", () => {
      expectPlan(createInspection({
        locked: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_LOCKED",
        automatic: false,
      });
    });

    it("locked has priority over prunable", () => {
      expectPlan(createInspection({
        locked: true,
        prunable: true,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_LOCKED",
        automatic: false,
      });
    });

    it("locked has priority on file paths", () => {
      expectPlan(createInspection({
        locked: true,
        pathKind: "FILE",
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_LOCKED",
        automatic: false,
      });
    });
  });

  describe("INCONSISTENT", () => {
    it("returns WORKTREE_INCONSISTENT for inconsistent state", () => {
      expectPlan(createInspection({
        state: "INCONSISTENT",
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks detached recoverable-looking state", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        detached: true,
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        locked: false,
        prunable: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks HEAD mismatch in recoverable-looking state", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        headMatchesBaseCommit: false,
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        branchMatchesExpected: null,
        detached: null,
        locked: false,
        prunable: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });

    it("blocks branch mismatch in recoverable-looking state", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchMatchesExpected: false,
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        detached: null,
        locked: false,
        prunable: false,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });
  });

  describe("RECOVERABLE", () => {
    it("unsupported recoverable state blocks manual review", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: false,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "UNSUPPORTED_RECOVERABLE_STATE",
        automatic: false,
      });
    });

    it("registered without path blocks manual review", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: true,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "UNSUPPORTED_RECOVERABLE_STATE",
        automatic: false,
      });
    });

    it("ambiguous partial fields block manual review", () => {
      expectPlan(createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: true,
        detached: null,
      }), {
        action: "BLOCK_MANUAL",
        reason: "WORKTREE_INCONSISTENT",
        automatic: false,
      });
    });
  });

  describe("PURENESS", () => {
    it("does not mutate the inspection object", () => {
      const inspection = createInspection({
        state: "RECOVERABLE",
        branchExists: true,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      });
      const before = structuredClone(inspection);

      planGitWorktreeReconciliation(inspection);

      expect(inspection).toEqual(before);
    });

    it("returns the same plan for the same input", () => {
      const inspection = createInspection({
        state: "CLEAN",
        branchExists: false,
        pathKind: "MISSING",
        worktreeRegistered: false,
        headMatchesBaseCommit: null,
        branchMatchesExpected: null,
        detached: null,
      });

      expect(planGitWorktreeReconciliation(inspection)).toEqual(planGitWorktreeReconciliation(inspection));
    });
  });
});
