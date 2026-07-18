/// <reference types="node" />

import { spawnSync } from "node:child_process";
import {
  inspectGitWorktreeState,
  type GitWorktreeInspectionResult,
} from "./git-worktree-service.js";
import {
  planGitWorktreeReconciliation,
  type GitWorktreeReconciliationPlan,
} from "./git-worktree-reconciliation-service.js";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface ExecuteGitWorktreeReconciliationInput {
  repositoryRoot: string;
  baseCommit: string;
  branchName: string;
  workspacePath: string;
}

export interface GitWorktreeReconciliationExecutionResult {
  initialInspection: GitWorktreeInspectionResult;
  initialPlan: GitWorktreeReconciliationPlan;
  finalInspection: GitWorktreeInspectionResult;
  finalPlan: GitWorktreeReconciliationPlan;
  executedAction: "NO_ACTION" | "REMOVE_BRANCH";
}

export type GitWorktreeReconciliationErrorCode =
  | "ACTION_BLOCKED"
  | "COMPLETE_WORKTREE"
  | "BRANCH_TIP_MISMATCH"
  | "BRANCH_IN_USE"
  | "STATE_CHANGED"
  | "BRANCH_DELETE_FAILED"
  | "POST_VALIDATION_FAILED";

export class GitWorktreeReconciliationError extends Error {
  readonly code: GitWorktreeReconciliationErrorCode;
  readonly repositoryRoot: string;
  readonly branchName: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly initialInspection?: GitWorktreeInspectionResult;
  readonly finalInspection?: GitWorktreeInspectionResult;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: GitWorktreeReconciliationErrorCode;
      repositoryRoot: string;
      branchName: string;
      workspacePath: string;
      baseCommit: string;
      initialInspection?: GitWorktreeInspectionResult;
      finalInspection?: GitWorktreeInspectionResult;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "GitWorktreeReconciliationError";
    this.code = options.code;
    this.repositoryRoot = options.repositoryRoot;
    this.branchName = options.branchName;
    this.workspacePath = options.workspacePath;
    this.baseCommit = options.baseCommit;
    this.initialInspection = options.initialInspection;
    this.finalInspection = options.finalInspection;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function runGitCommand(
  repositoryRoot: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

function assertIsCleanOrThrow(
  inspection: GitWorktreeInspectionResult,
  plan: GitWorktreeReconciliationPlan,
  input: ExecuteGitWorktreeReconciliationInput,
  initialInspection: GitWorktreeInspectionResult,
  initialPlan: GitWorktreeReconciliationPlan,
  cause?: unknown,
): void {
  if (
    inspection.state === "CLEAN"
    && plan.action === "NO_ACTION"
    && plan.reason === "ALREADY_CLEAN"
  ) {
    return;
  }

  if (plan.action === "NO_ACTION" && plan.reason === "WORKTREE_COMPLETE") {
    throw new GitWorktreeReconciliationError(
      "El worktree está completo y no debe eliminarse.",
      {
        code: "COMPLETE_WORKTREE",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection: inspection,
        cause,
      },
    );
  }

  throw new GitWorktreeReconciliationError(
    `El estado del worktree cambió inesperadamente: ${inspection.state}`,
    {
      code: "STATE_CHANGED",
      repositoryRoot: input.repositoryRoot,
      branchName: input.branchName,
      workspacePath: input.workspacePath,
      baseCommit: input.baseCommit,
      initialInspection,
      finalInspection: inspection,
      cause,
    },
  );
}

function verifyBranchTip(
  input: ExecuteGitWorktreeReconciliationInput,
  initialInspection: GitWorktreeInspectionResult,
  initialPlan: GitWorktreeReconciliationPlan,
): void {
  const result = runGitCommand(input.repositoryRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${input.branchName}`,
  ]);

  if (result.status === null) {
    const reinspect = inspectGitWorktreeState(input);
    const replan = planGitWorktreeReconciliation(reinspect);
    assertIsCleanOrThrow(reinspect, replan, input, initialInspection, initialPlan, result.stderr);
    return;
  }

  if (result.status !== 0) {
    const reinspect = inspectGitWorktreeState(input);
    const replan = planGitWorktreeReconciliation(reinspect);
    assertIsCleanOrThrow(reinspect, replan, input, initialInspection, initialPlan, result.stderr);
    return;
  }

  if (!COMMIT_SHA_PATTERN.test(result.stdout)) {
    const reinspect = inspectGitWorktreeState(input);
    const replan = planGitWorktreeReconciliation(reinspect);
    assertIsCleanOrThrow(reinspect, replan, input, initialInspection, initialPlan, result.stdout);
    return;
  }

  if (result.stdout.toLowerCase() !== input.baseCommit.toLowerCase()) {
    throw new GitWorktreeReconciliationError(
      "El tip de la rama no coincide con el commit base esperado.",
      {
        code: "BRANCH_TIP_MISMATCH",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
      },
    );
  }
}

function verifyBranchNotInUse(
  input: ExecuteGitWorktreeReconciliationInput,
  initialInspection: GitWorktreeInspectionResult,
  initialPlan: GitWorktreeReconciliationPlan,
): void {
  const result = runGitCommand(input.repositoryRoot, [
    "worktree",
    "list",
    "--porcelain",
  ]);

  if (result.status === null || result.status !== 0) {
    throw new GitWorktreeReconciliationError(
      "No se pudieron listar los worktrees para verificar uso de rama.",
      {
        code: "STATE_CHANGED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
      },
    );
  }

  const lines = result.stdout.split("\n");
  const targetLine = `branch refs/heads/${input.branchName}`;

  for (const line of lines) {
    if (line === targetLine) {
      throw new GitWorktreeReconciliationError(
        "La rama está siendo utilizada por un worktree registrado.",
        {
          code: "BRANCH_IN_USE",
          repositoryRoot: input.repositoryRoot,
          branchName: input.branchName,
          workspacePath: input.workspacePath,
          baseCommit: input.baseCommit,
          initialInspection,
        },
      );
    }
  }
}

export function executeGitWorktreeReconciliation(
  input: ExecuteGitWorktreeReconciliationInput,
): GitWorktreeReconciliationExecutionResult {
  const initialInspection = inspectGitWorktreeState(input);
  const initialPlan = planGitWorktreeReconciliation(initialInspection);

  if (initialPlan.action === "NO_ACTION") {
    const secondInspection = inspectGitWorktreeState(input);
    const secondPlan = planGitWorktreeReconciliation(secondInspection);

    if (
      secondPlan.action === "NO_ACTION"
      && secondPlan.reason === "ALREADY_CLEAN"
    ) {
      return {
        initialInspection,
        initialPlan,
        finalInspection: secondInspection,
        finalPlan: secondPlan,
        executedAction: "NO_ACTION",
      };
    }

    if (
      secondPlan.action === "NO_ACTION"
      && secondPlan.reason === "WORKTREE_COMPLETE"
    ) {
      throw new GitWorktreeReconciliationError(
        "El worktree está completo y no debe eliminarse.",
        {
          code: "COMPLETE_WORKTREE",
          repositoryRoot: input.repositoryRoot,
          branchName: input.branchName,
          workspacePath: input.workspacePath,
          baseCommit: input.baseCommit,
          initialInspection,
          finalInspection: secondInspection,
        },
      );
    }

    throw new GitWorktreeReconciliationError(
      `El estado del worktree cambió inesperadamente: ${secondInspection.state}`,
      {
        code: "STATE_CHANGED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection: secondInspection,
      },
    );
  }

  if (initialPlan.action === "BLOCK_MANUAL") {
    throw new GitWorktreeReconciliationError(
      `La acción requiere intervención manual: ${initialPlan.reason}`,
      {
        code: "ACTION_BLOCKED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
      },
    );
  }

  const preDeleteInspection = inspectGitWorktreeState(input);
  const preDeletePlan = planGitWorktreeReconciliation(preDeleteInspection);

  if (
    preDeletePlan.action === "NO_ACTION"
    && preDeletePlan.reason === "ALREADY_CLEAN"
  ) {
    const finalInspection = preDeleteInspection;
    const finalPlan = preDeletePlan;
    return {
      initialInspection,
      initialPlan,
      finalInspection,
      finalPlan,
      executedAction: "NO_ACTION",
    };
  }

  if (
    preDeletePlan.action === "NO_ACTION"
    && preDeletePlan.reason === "WORKTREE_COMPLETE"
  ) {
    throw new GitWorktreeReconciliationError(
      "El worktree está completo y no debe eliminarse.",
      {
        code: "COMPLETE_WORKTREE",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection: preDeleteInspection,
      },
    );
  }

  if (
    preDeletePlan.action !== "REMOVE_BRANCH"
    || preDeletePlan.reason !== "ORPHAN_BRANCH"
    || preDeletePlan.automatic !== true
  ) {
    throw new GitWorktreeReconciliationError(
      `El estado del worktree cambió inesperadamente: ${preDeleteInspection.state}`,
      {
        code: "STATE_CHANGED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection: preDeleteInspection,
      },
    );
  }

  verifyBranchTip(input, initialInspection, initialPlan);
  verifyBranchNotInUse(input, initialInspection, initialPlan);

  const thirdInspection = inspectGitWorktreeState(input);
  const thirdPlan = planGitWorktreeReconciliation(thirdInspection);

  if (
    thirdPlan.action === "NO_ACTION"
    && thirdPlan.reason === "ALREADY_CLEAN"
  ) {
    return {
      initialInspection,
      initialPlan,
      finalInspection: thirdInspection,
      finalPlan: thirdPlan,
      executedAction: "NO_ACTION",
    };
  }

  if (
    thirdPlan.action !== "REMOVE_BRANCH"
    || thirdPlan.reason !== "ORPHAN_BRANCH"
    || thirdPlan.automatic !== true
  ) {
    throw new GitWorktreeReconciliationError(
      `El estado del worktree cambió inesperadamente: ${thirdInspection.state}`,
      {
        code: "STATE_CHANGED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection: thirdInspection,
      },
    );
  }

  verifyBranchTip(input, initialInspection, initialPlan);
  verifyBranchNotInUse(input, initialInspection, initialPlan);

  const deleteResult = runGitCommand(input.repositoryRoot, [
    "branch",
    "-D",
    input.branchName,
  ]);

  if (deleteResult.status === null) {
    throw new GitWorktreeReconciliationError(
      "No se pudo ejecutar Git para eliminar la rama.",
      {
        code: "BRANCH_DELETE_FAILED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        cause: deleteResult.stderr,
      },
    );
  }

  if (deleteResult.status !== 0) {
    const postFailInspection = inspectGitWorktreeState(input);
    const postFailPlan = planGitWorktreeReconciliation(postFailInspection);

    if (
      postFailPlan.action === "NO_ACTION"
      && postFailPlan.reason === "ALREADY_CLEAN"
    ) {
      return {
        initialInspection,
        initialPlan,
        finalInspection: postFailInspection,
        finalPlan: postFailPlan,
        executedAction: "NO_ACTION",
      };
    }

    throw new GitWorktreeReconciliationError(
      "Git devolvió un código de salida distinto de 0 al eliminar la rama.",
      {
        code: "BRANCH_DELETE_FAILED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection: postFailInspection,
        cause: deleteResult.stderr,
      },
    );
  }

  const finalInspection = inspectGitWorktreeState(input);
  const finalPlan = planGitWorktreeReconciliation(finalInspection);

  if (
    finalInspection.state !== "CLEAN"
    || finalPlan.action !== "NO_ACTION"
    || finalPlan.reason !== "ALREADY_CLEAN"
    || finalPlan.automatic !== true
  ) {
    throw new GitWorktreeReconciliationError(
      "La post-validación falló tras eliminar la rama.",
      {
        code: "POST_VALIDATION_FAILED",
        repositoryRoot: input.repositoryRoot,
        branchName: input.branchName,
        workspacePath: input.workspacePath,
        baseCommit: input.baseCommit,
        initialInspection,
        finalInspection,
      },
    );
  }

  return {
    initialInspection,
    initialPlan,
    finalInspection,
    finalPlan,
    executedAction: "REMOVE_BRANCH",
  };
}
