import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import { getTaskWorkspaceById } from "../../src/repositories/task-workspace-repository.js";
import {
  createTaskWorkspaceForExecution,
  WorkspaceCreationError,
} from "../../src/services/workspace-creation-service.js";
import { reconcileFailedTaskWorkspace } from "../../src/services/workspace-reconciliation-service.js";
import { retryFailedTaskWorkspace } from "../../src/services/workspace-retry-service.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import { createTempDirectory, type TempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository, type TempGitRepository } from "../helpers/temp-git-repository.js";

function getGitWorktreeList(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    shell: false,
  }).stdout;
}

function getGitHead(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    shell: false,
  }).stdout.trim().toLowerCase();
}

function branchExists(repoPath: string, branchName: string): boolean {
  return spawnSync(
    "git",
    ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { encoding: "utf8", shell: false },
  ).status === 0;
}

function createExactWorktreeAddShim(input: {
  repositoryRoot: string;
  branchName: string;
  workspacePath: string;
  baseCommit: string;
}): { path: string; cleanup(): void } {
  const dir = createTempDirectory("devflow-git-worktree-add-shim");
  const realGitResult = spawnSync("sh", ["-lc", "command -v git"], { encoding: "utf8" });

  if (realGitResult.status !== 0) {
    dir.cleanup();
    throw new Error("No se pudo localizar el binario real de git.");
  }

  const realGit = realGitResult.stdout.trim();
  const scriptPath = join(dir.path, "git");

  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$2" = ${JSON.stringify(input.repositoryRoot)} ] && [ "$3" = "worktree" ] && [ "$4" = "add" ] && [ "$5" = "-b" ] && [ "$6" = ${JSON.stringify(input.branchName)} ] && [ "$7" = ${JSON.stringify(input.workspacePath)} ] && [ "$8" = ${JSON.stringify(input.baseCommit)} ] && [ "$#" -eq 8 ]; then
  exit 128
fi
exec ${JSON.stringify(realGit)} "$@"
`,
  );
  chmodSync(scriptPath, 0o755);

  return {
    path: dir.path,
    cleanup(): void {
      dir.cleanup();
    },
  };
}

function withGitShim<T>(shim: { path: string; cleanup(): void }, action: () => T): T {
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${shim.path}:${previousPath}`;

  try {
    return action();
  } finally {
    process.env.PATH = previousPath;
    shim.cleanup();
  }
}

describe("phase five workspace lifecycle", () => {
  let tempDb: TempDatabase | null = null;
  let tempHome: TempDirectory | null = null;
  let repo: TempGitRepository | null = null;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempHome = createTempDirectory("devflow-phase-five-home");
    process.env.HOME = tempHome.path;
  });

  afterEach(() => {
    try {
      if (repo !== null) {
        try {
          const worktreeList = getGitWorktreeList(repo.path);
          const blocks = worktreeList.split("\n\n").filter((block) => block.trim().length > 0);
          for (const block of blocks) {
            const worktreeMatch = block.match(/^worktree (.+)$/m);
            const worktreePath = worktreeMatch?.[1];
            if (worktreePath !== undefined && worktreePath !== repo.path) {
              spawnSync(
                "git",
                ["-C", repo.path, "worktree", "remove", worktreePath, "--force"],
                { encoding: "utf8", shell: false },
              );
            }
          }

          const branchList = repo.runGit(["branch", "--list"]);
          const branches = branchList
            .split("\n")
            .map((branch) => branch.replace(/^\*?\s+/, "").trim())
            .filter((branch) => branch.length > 0 && branch !== "main");
          for (const branch of branches) {
            repo.runGit(["branch", "-D", branch]);
          }
        } catch {
          // Cleanup is best-effort.
        }

        repo.cleanup();
        repo = null;
      }
    } finally {
      tempDb?.cleanup();
      tempDb = null;

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      tempHome?.cleanup();
      tempHome = null;
      previousHome = undefined;
    }
  });

  it("covers failure, reconciliation, and retry using the same persisted workspace identity", () => {
    tempDb = createTempDatabase();
    repo = createTempGitRepository();

    const project = createProject(tempDb.database, {
      id: "proj-1",
      name: "Test Project",
      repositoryPath: repo.path,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });

    const task = createTask(tempDb.database, {
      id: "TASK-001",
      projectId: project.id,
      title: "Test Task",
      description: "A test task",
      state: "PREPARING_WORKSPACE",
      attempt: 1,
      maxAttempts: 3,
      contractJson: null,
      currentRevisionJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const initialTask = getTaskById(tempDb.database, task.id);
    expect(initialTask).not.toBeNull();
    const initialTaskState = initialTask!.state;
    const initialTaskAttempt = initialTask!.attempt;
    const mainHeadBefore = getGitHead(repo.path);
    const expectedExecutionNumber = initialTaskAttempt + 1;
    const expectedWorkspaceId = `${project.id}:${task.id}:${expectedExecutionNumber}`;
    const expectedBranchName = `devflow/${project.id}/${task.id}/execution-${expectedExecutionNumber}`;
    const expectedWorkspacePath = join(
      process.env.HOME!,
      ".devflow",
      "worktrees",
      project.id,
      task.id,
      String(expectedExecutionNumber),
    );
    const expectedBaseCommit = mainHeadBefore;

    const shim = createExactWorktreeAddShim({
      repositoryRoot: repo.path,
      branchName: expectedBranchName,
      workspacePath: expectedWorkspacePath,
      baseCommit: expectedBaseCommit,
    });

    try {
      withGitShim(shim, () => {
        createTaskWorkspaceForExecution(tempDb!.database, task.id);
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceCreationError);
      expect((error as WorkspaceCreationError).phase).toBe("CREATE_WORKTREE");
      expect((error as WorkspaceCreationError).workspaceId).toBe(expectedWorkspaceId);
    }

    const failedWorkspace = getTaskWorkspaceById(tempDb.database, expectedWorkspaceId);
    expect(failedWorkspace).not.toBeNull();
    expect(failedWorkspace!.status).toBe("FAILED");
    expect(failedWorkspace!.id).toBe(expectedWorkspaceId);
    expect(failedWorkspace!.taskId).toBe(task.id);
    expect(failedWorkspace!.executionNumber).toBe(expectedExecutionNumber);
    expect(failedWorkspace!.branchName).toBe(expectedBranchName);
    expect(failedWorkspace!.workspacePath).toBe(expectedWorkspacePath);
    expect(failedWorkspace!.baseCommit).toBe(expectedBaseCommit);

    expect(branchExists(repo.path, expectedBranchName)).toBe(false);
    expect(existsSync(expectedWorkspacePath)).toBe(false);
    expect(getGitWorktreeList(repo.path)).not.toContain(`worktree ${expectedWorkspacePath}`);

    const afterFailureTask = getTaskById(tempDb.database, task.id);
    expect(afterFailureTask).not.toBeNull();
    expect(afterFailureTask!.state).toBe(initialTaskState);
    expect(afterFailureTask!.attempt).toBe(initialTaskAttempt);

    const reconciliation = reconcileFailedTaskWorkspace(tempDb.database, expectedWorkspaceId);
    expect(reconciliation.outcome).toBe("ALREADY_CLEAN");
    expect(reconciliation.workspace.status).toBe("FAILED");
    expect(reconciliation.workspace.id).toBe(expectedWorkspaceId);

    const afterReconciliationTask = getTaskById(tempDb.database, task.id);
    expect(afterReconciliationTask).not.toBeNull();
    expect(afterReconciliationTask!.state).toBe(initialTaskState);
    expect(afterReconciliationTask!.attempt).toBe(initialTaskAttempt);

    const retriedWorkspace = retryFailedTaskWorkspace(tempDb.database, expectedWorkspaceId);
    expect(retriedWorkspace.status).toBe("READY");
    expect(retriedWorkspace.id).toBe(expectedWorkspaceId);
    expect(retriedWorkspace.taskId).toBe(task.id);
    expect(retriedWorkspace.executionNumber).toBe(expectedExecutionNumber);
    expect(retriedWorkspace.branchName).toBe(expectedBranchName);
    expect(retriedWorkspace.workspacePath).toBe(expectedWorkspacePath);
    expect(retriedWorkspace.baseCommit).toBe(expectedBaseCommit);

    expect(existsSync(retriedWorkspace.workspacePath)).toBe(true);
    expect(getGitWorktreeList(repo.path)).toContain(`worktree ${retriedWorkspace.workspacePath}`);
    expect(branchExists(repo.path, retriedWorkspace.branchName)).toBe(true);
    expect(getGitHead(retriedWorkspace.workspacePath)).toBe(expectedBaseCommit);

    const finalTask = getTaskById(tempDb.database, task.id);
    expect(finalTask).not.toBeNull();
    expect(finalTask!.state).toBe(initialTaskState);
    expect(finalTask!.state).not.toBe("EXECUTING");
    expect(finalTask!.attempt).toBe(initialTaskAttempt);

    const allRows = tempDb.database
      .prepare("SELECT id FROM task_workspaces WHERE taskId = ?")
      .all(task.id) as Record<string, unknown>[];
    expect(allRows).toHaveLength(1);
    expect(String(allRows[0]!["id"])).toBe(expectedWorkspaceId);

    expect(getGitHead(repo.path)).toBe(mainHeadBefore);
  });
});
