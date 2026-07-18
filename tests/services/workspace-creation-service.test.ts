import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import type { Project, Task } from "../../src/types.js";
import {
  createTaskWorkspace,
  updateTaskWorkspaceStatus,
} from "../../src/repositories/task-workspace-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import type { TempGitRepository } from "../helpers/temp-git-repository.js";
import {
  createTaskWorkspaceForExecution,
  WorkspaceCreationError,
} from "../../src/services/workspace-creation-service.js";

function setupProjectAndTask(
  tempDb: TempDatabase,
  repo: TempGitRepository,
  overrides: {
    attempt?: number;
    maxAttempts?: number;
    state?: Task["state"];
  } = {},
): { project: Project; task: Task } {
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
    state: overrides.state ?? "PREPARING_WORKSPACE",
    attempt: overrides.attempt ?? 0,
    maxAttempts: overrides.maxAttempts ?? 2,
    contractJson: null,
    currentRevisionJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return { project, task };
}

function getGitWorktreeList(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  }).stdout;
}

function getGitStatus(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "status", "--short"], {
    encoding: "utf8",
  }).stdout;
}

function getGitHead(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
}

describe("workspace creation service", () => {
  let tempDb: TempDatabase | null = null;
  let repo: TempGitRepository | null = null;

  afterEach(() => {
    if (repo !== null) {
      try {
        const worktreeList = getGitWorktreeList(repo.path);
        const blocks = worktreeList.split("\n\n").filter((b) => b.trim().length > 0);
        for (const block of blocks) {
          const worktreeMatch = block.match(/^worktree (.+)$/m);
          const worktreePath = worktreeMatch?.[1];
          if (worktreePath !== undefined && worktreePath !== repo.path) {
            spawnSync("git", ["-C", repo.path, "worktree", "remove", worktreePath, "--force"], {
              encoding: "utf8",
            });
          }
        }

        const branchList = repo.runGit(["branch", "--list"]);
        const branches = branchList
          .split("\n")
          .map((b) => b.replace(/^\*?\s+/, "").trim())
          .filter((b) => b.length > 0 && b !== "main");
        for (const branch of branches) {
          repo.runGit(["branch", "-D", branch]);
        }
      } catch {
        // Cleanup is best-effort.
      }

      repo.cleanup();
      repo = null;
    }

    tempDb?.cleanup();
    tempDb = null;
  });

  describe("happy path", () => {
    it("creates a workspace complete and returns workspace and repositoryRoot", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);
      const headBefore = getGitHead(repo.path);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(result.workspace).toBeDefined();
        expect(result.repositoryRoot).toBe(repo.path);
        expect(result.workspace.status).toBe("READY");
        expect(result.workspace.taskId).toBe(task.id);
        expect(result.workspace.executionNumber).toBe(1);
        expect(result.workspace.id).toBe("proj-1:TASK-001:1");
        expect(result.workspace.workspacePath).toContain("proj-1");
        expect(result.workspace.workspacePath).toContain("TASK-001");
        expect(result.workspace.workspacePath).toContain("1");
        expect(result.workspace.branchName).toBe("devflow/proj-1/TASK-001/execution-1");
        expect(result.workspace.baseCommit).toBe(headBefore.toLowerCase());
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("Task transitions to EXECUTING", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        const updatedTask = getTaskById(tempDb.database, task.id);
        expect(updatedTask).not.toBeNull();
        expect(updatedTask!.state).toBe("EXECUTING");
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("workspaceId is correct", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(result.workspace.id).toBe("proj-1:TASK-001:1");
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("executionNumber is task.attempt + 1", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo, { attempt: 2, maxAttempts: 5 });

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(result.workspace.executionNumber).toBe(3);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-3"]);
      }
    });

    it("workspacePath is correct", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        const expectedPath = join(
          process.env.HOME ?? "~",
          ".devflow",
          "worktrees",
          "proj-1",
          "TASK-001",
          "1",
        );
        expect(result.workspace.workspacePath).toBe(expectedPath);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("branchName is correct", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(result.workspace.branchName).toBe("devflow/proj-1/TASK-001/execution-1");
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("baseCommit matches initial HEAD", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);
      const headBefore = getGitHead(repo.path);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(result.workspace.baseCommit).toBe(headBefore.toLowerCase());
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("physical worktree exists and is registered", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(existsSync(result.workspace.workspacePath)).toBe(true);
        const list = getGitWorktreeList(repo.path);
        expect(list).toContain(`worktree ${result.workspace.workspacePath}`);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("main repo preserves HEAD and status", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);
      const headBefore = getGitHead(repo.path);
      const statusBefore = getGitStatus(repo.path);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        expect(getGitHead(repo.path)).toBe(headBefore);
        expect(getGitStatus(repo.path)).toBe(statusBefore);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("persists across reopen", async () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);
      const dbPath = tempDb.databasePath;
      const worktreePath = result.workspace.workspacePath;

      try {
        tempDb.close();

        const { initializeSchema, openDatabase } = await import("../../src/db.js");
        const reopened = openDatabase(dbPath);
        initializeSchema(reopened);

        const row = reopened
          .prepare("SELECT * FROM task_workspaces WHERE id = ?")
          .get(result.workspace.id) as Record<string, unknown> | undefined;
        expect(row).toBeDefined();
        expect(String(row!["status"])).toBe("READY");
        expect(String(row!["taskId"])).toBe(task.id);

        const taskRow = reopened
          .prepare("SELECT * FROM tasks WHERE id = ?")
          .get(task.id) as Record<string, unknown> | undefined;
        expect(taskRow).toBeDefined();
        expect(String(taskRow!["state"])).toBe("EXECUTING");

        reopened.close();
        tempDb = null;
      } finally {
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });

    it("Task.attempt does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo, { attempt: 0 });

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        const updatedTask = getTaskById(tempDb.database, task.id);
        expect(updatedTask!.attempt).toBe(0);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });
  });

  describe("validations", () => {
    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      try {
        createTaskWorkspaceForExecution(tempDb.database, "");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("LOAD_TASK");
        expect((error as WorkspaceCreationError).message).toBe(
          "El id de la tarea no puede estar vacío.",
        );
      }
    });

    it("rejects nonexistent task", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      try {
        createTaskWorkspaceForExecution(tempDb.database, "NONEXISTENT");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("LOAD_TASK");
        expect((error as WorkspaceCreationError).message).toBe(
          "No existe la tarea: NONEXISTENT",
        );
      }
    });

    it("rejects task in invalid state", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo, { state: "CREATED" });

      try {
        createTaskWorkspaceForExecution(tempDb.database, task.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("VALIDATE_TASK");
        expect((error as WorkspaceCreationError).message).toContain("no puede preparar un workspace desde el estado CREATED");
      }
    });

    it("rejects nonexistent project", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const project = createProject(tempDb.database, {
        id: "ghost",
        name: "ghost",
        repositoryPath: "/tmp/ghost",
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
      });

      tempDb.database.prepare("PRAGMA foreign_keys = OFF").run();
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          `INSERT INTO tasks (id, projectId, title, description, state, attempt, maxAttempts, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("TASK-GHOST", "nonexistent-project", "Ghost task", "desc", "PREPARING_WORKSPACE", 0, 3, now, now);
      tempDb.database.prepare("PRAGMA foreign_keys = ON").run();

      try {
        createTaskWorkspaceForExecution(tempDb.database, "TASK-GHOST");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("LOAD_PROJECT");
        expect((error as WorkspaceCreationError).message).toContain("No existe el proyecto");
      }
    });

    it("rejects attempt >= maxAttempts", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo, { attempt: 2, maxAttempts: 2 });

      try {
        createTaskWorkspaceForExecution(tempDb.database, task.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("CALCULATE_EXECUTION_NUMBER");
        expect((error as WorkspaceCreationError).message).toContain("alcanzó el máximo de intentos: 2/2");
      }
    });
  });

  describe("workspace existente", () => {
    it("rejects workspace PREPARING", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test-preparing",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: getGitHead(repo.path),
      });

      try {
        createTaskWorkspaceForExecution(tempDb.database, task.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("CHECK_EXISTING_WORKSPACE");
        expect((error as WorkspaceCreationError).message).toContain("workspace PREPARING");
      }
    });

    it("rejects workspace READY", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test-ready",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: getGitHead(repo.path),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "READY");

      try {
        createTaskWorkspaceForExecution(tempDb.database, task.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("CHECK_EXISTING_WORKSPACE");
        expect((error as WorkspaceCreationError).message).toContain("workspace READY");
      }
    });

    it("rejects workspace FAILED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test-failed",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: getGitHead(repo.path),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        createTaskWorkspaceForExecution(tempDb.database, task.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("CHECK_EXISTING_WORKSPACE");
        expect((error as WorkspaceCreationError).message).toContain("workspace FAILED");
      }
    });

    it("rejects workspace REMOVED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test-removed",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: getGitHead(repo.path),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "READY");
      tempDb.database
        .prepare("UPDATE task_workspaces SET status = 'REMOVED', removedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), ws.id);

      try {
        createTaskWorkspaceForExecution(tempDb.database, task.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCreationError);
        expect((error as WorkspaceCreationError).phase).toBe("CHECK_EXISTING_WORKSPACE");
        expect((error as WorkspaceCreationError).message).toContain("workspace REMOVED");
      }
    });
  });

  describe("error domain", () => {
    it("WorkspaceCreationError extends Error", () => {
      const error = new WorkspaceCreationError("test", {
        taskId: "TASK-001",
        phase: "LOAD_TASK",
      });
      expect(error).toBeInstanceOf(Error);
    });

    it("name is WorkspaceCreationError", () => {
      const error = new WorkspaceCreationError("test", {
        taskId: "TASK-001",
        phase: "LOAD_TASK",
      });
      expect(error.name).toBe("WorkspaceCreationError");
    });

    it("preserves taskId, projectId, workspaceId, and phase", () => {
      const cause = new Error("original");
      const error = new WorkspaceCreationError("test", {
        taskId: "TASK-001",
        projectId: "proj-1",
        workspaceId: "ws-001",
        phase: "CREATE_WORKTREE",
        cause,
      });
      expect(error.taskId).toBe("TASK-001");
      expect(error.projectId).toBe("proj-1");
      expect(error.workspaceId).toBe("ws-001");
      expect(error.phase).toBe("CREATE_WORKTREE");
      expect(error.cause).toBe(cause);
    });
  });

  describe("isolation", () => {
    it("does not increment Task.attempt", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo, { attempt: 1 });

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        const updatedTask = getTaskById(tempDb.database, task.id);
        expect(updatedTask!.attempt).toBe(1);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-2"]);
      }
    });

    it("does not modify other tasks", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project, task } = setupProjectAndTask(tempDb, repo);

      const otherTask = createTask(tempDb.database, {
        id: "TASK-002",
        projectId: project.id,
        title: "Other Task",
        description: "Another",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = createTaskWorkspaceForExecution(tempDb.database, task.id);

      try {
        const otherAfter = getTaskById(tempDb.database, "TASK-002");
        expect(otherAfter!.state).toBe("CREATED");
        expect(otherAfter!.attempt).toBe(0);
      } finally {
        const worktreePath = result.workspace.workspacePath;
        if (existsSync(worktreePath)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", worktreePath], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", "devflow/proj-1/TASK-001/execution-1"]);
      }
    });
  });

  describe("two isolated projects", () => {
    it("creates workspaces for different projects independently", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      const project1 = createProject(tempDb.database, {
        id: "proj-a",
        name: "Project A",
        repositoryPath: repo.path,
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
      });

      const project2 = createProject(tempDb.database, {
        id: "proj-b",
        name: "Project B",
        repositoryPath: repo.path,
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
      });

      const task1 = createTask(tempDb.database, {
        id: "TASK-A1",
        projectId: project1.id,
        title: "Task A1",
        description: "desc",
        state: "PREPARING_WORKSPACE",
        attempt: 0,
        maxAttempts: 2,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const task2 = createTask(tempDb.database, {
        id: "TASK-B1",
        projectId: project2.id,
        title: "Task B1",
        description: "desc",
        state: "PREPARING_WORKSPACE",
        attempt: 0,
        maxAttempts: 2,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result1 = createTaskWorkspaceForExecution(tempDb.database, task1.id);

      try {
        const result2 = createTaskWorkspaceForExecution(tempDb.database, task2.id);

        try {
          expect(result1.workspace.id).not.toBe(result2.workspace.id);
          expect(result1.workspace.branchName).not.toBe(result2.workspace.branchName);
          expect(result1.workspace.executionNumber).toBe(1);
          expect(result2.workspace.executionNumber).toBe(1);

          const task1After = getTaskById(tempDb.database, "TASK-A1");
          const task2After = getTaskById(tempDb.database, "TASK-B1");
          expect(task1After!.state).toBe("EXECUTING");
          expect(task2After!.state).toBe("EXECUTING");
        } finally {
          const wt2 = result2.workspace.workspacePath;
          if (existsSync(wt2)) {
            spawnSync("git", ["-C", repo!.path, "worktree", "remove", wt2], { encoding: "utf8" });
          }
          repo!.runGit(["branch", "-D", result2.workspace.branchName]);
        }
      } finally {
        const wt1 = result1.workspace.workspacePath;
        if (existsSync(wt1)) {
          spawnSync("git", ["-C", repo!.path, "worktree", "remove", wt1], { encoding: "utf8" });
        }
        repo!.runGit(["branch", "-D", result1.workspace.branchName]);
      }
    });
  });
});
