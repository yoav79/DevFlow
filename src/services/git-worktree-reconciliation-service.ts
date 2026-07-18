/// <reference types="node" />

import type { GitWorktreeInspectionResult } from "./git-worktree-service.js";

export type GitWorktreeReconciliationAction =
  | "NO_ACTION"
  | "REMOVE_BRANCH"
  | "BLOCK_MANUAL";

export type GitWorktreeReconciliationReason =
  | "ALREADY_CLEAN"
  | "WORKTREE_COMPLETE"
  | "ORPHAN_BRANCH"
  | "PATH_REQUIRES_MANUAL_REVIEW"
  | "WORKTREE_PRUNABLE"
  | "WORKTREE_LOCKED"
  | "WORKTREE_INCONSISTENT"
  | "UNSUPPORTED_RECOVERABLE_STATE";

export interface GitWorktreeReconciliationPlan {
  action: GitWorktreeReconciliationAction;
  reason: GitWorktreeReconciliationReason;
  automatic: boolean;
}

function isCleanCoherent(inspection: GitWorktreeInspectionResult): boolean {
  return inspection.branchExists === false
    && inspection.pathKind === "MISSING"
    && inspection.worktreeRegistered === false;
}

function isCompleteCoherent(inspection: GitWorktreeInspectionResult): boolean {
  return inspection.branchExists === true
    && inspection.pathKind === "DIRECTORY"
    && inspection.worktreeRegistered === true
    && inspection.headMatchesBaseCommit === true
    && inspection.branchMatchesExpected === true
    && inspection.detached === false
    && inspection.locked === false
    && inspection.prunable === false;
}

function isOrphanBranch(inspection: GitWorktreeInspectionResult): boolean {
  return inspection.state === "RECOVERABLE"
    && inspection.branchExists === true
    && inspection.pathKind === "MISSING"
    && inspection.worktreeRegistered === false
    && inspection.headMatchesBaseCommit === null
    && inspection.branchMatchesExpected === null
    && inspection.detached === null
    && inspection.locked === false
    && inspection.prunable === false;
}

export function planGitWorktreeReconciliation(
  inspection: GitWorktreeInspectionResult,
): GitWorktreeReconciliationPlan {
  if (inspection.locked === true) {
    return {
      action: "BLOCK_MANUAL",
      reason: "WORKTREE_LOCKED",
      automatic: false,
    };
  }

  if (inspection.pathKind === "FILE" || inspection.pathKind === "SYMLINK") {
    return {
      action: "BLOCK_MANUAL",
      reason: "PATH_REQUIRES_MANUAL_REVIEW",
      automatic: false,
    };
  }

  if (inspection.state === "INCONSISTENT") {
    return {
      action: "BLOCK_MANUAL",
      reason: "WORKTREE_INCONSISTENT",
      automatic: false,
    };
  }

  if (inspection.prunable === true) {
    return {
      action: "BLOCK_MANUAL",
      reason: "WORKTREE_PRUNABLE",
      automatic: false,
    };
  }

  if (inspection.state === "CLEAN") {
    if (isCleanCoherent(inspection)) {
      return {
        action: "NO_ACTION",
        reason: "ALREADY_CLEAN",
        automatic: true,
      };
    }

    return {
      action: "BLOCK_MANUAL",
      reason: "WORKTREE_INCONSISTENT",
      automatic: false,
    };
  }

  if (inspection.state === "COMPLETE") {
    if (isCompleteCoherent(inspection)) {
      return {
        action: "NO_ACTION",
        reason: "WORKTREE_COMPLETE",
        automatic: true,
      };
    }

    return {
      action: "BLOCK_MANUAL",
      reason: "WORKTREE_INCONSISTENT",
      automatic: false,
    };
  }

  if (isOrphanBranch(inspection)) {
    return {
      action: "REMOVE_BRANCH",
      reason: "ORPHAN_BRANCH",
      automatic: true,
    };
  }

  if (
    inspection.headMatchesBaseCommit === false
    || inspection.branchMatchesExpected === false
    || inspection.detached === true
    || (
      inspection.state === "RECOVERABLE"
      && (
        inspection.headMatchesBaseCommit !== null
        || inspection.branchMatchesExpected !== null
        || inspection.detached !== null
      )
    )
  ) {
    return {
      action: "BLOCK_MANUAL",
      reason: "WORKTREE_INCONSISTENT",
      automatic: false,
    };
  }

  if (inspection.pathKind === "DIRECTORY") {
    return {
      action: "BLOCK_MANUAL",
      reason: "PATH_REQUIRES_MANUAL_REVIEW",
      automatic: false,
    };
  }

  if (inspection.state === "RECOVERABLE") {
    return {
      action: "BLOCK_MANUAL",
      reason: "UNSUPPORTED_RECOVERABLE_STATE",
      automatic: false,
    };
  }

  return {
    action: "BLOCK_MANUAL",
    reason: "WORKTREE_INCONSISTENT",
    automatic: false,
  };
}
