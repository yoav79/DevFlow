/// <reference types="node" />

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DevFlowPathError,
  getArtifactPath,
  getArtifactsRoot,
  getDevFlowDataRoot,
  getLogPath,
  getLogsRoot,
  getRunPath,
  getRunsRoot,
  getWorkspacePath,
  getWorktreesRoot,
  validateAttempt,
  validatePathIdentifier,
} from "../../src/services/devflow-paths.js";
import { createTempDirectory } from "../helpers/temp-directory.js";

function expectPathError(action: () => unknown, message: string, field: string, value: unknown): void {
  try {
    action();
    throw new Error("Expected DevFlowPathError.");
  } catch (error) {
    expect(error).toBeInstanceOf(DevFlowPathError);
    expect((error as DevFlowPathError).message).toBe(message);
    expect((error as DevFlowPathError).field).toBe(field);
    expect((error as DevFlowPathError).value).toBe(value);
  }
}

function expectInsideRoot(path: string, root: string): void {
  expect(path === root || path.startsWith(`${root}${sep}`)).toBe(true);
}

describe("devflow paths", () => {
  describe("data root", () => {
    it("uses ~/.devflow by default", () => {
      expect(getDevFlowDataRoot()).toBe(join(homedir(), ".devflow"));
    });

    it("accepts an explicit absolute dataRoot", () => {
      const root = resolve("/tmp/devflow-root");
      expect(getDevFlowDataRoot({ dataRoot: root })).toBe(root);
    });

    it("normalizes dataRoot with resolve", () => {
      const directory = createTempDirectory();

      try {
        const input = join(directory.path, "nested", "..", "data-root");
        expect(getDevFlowDataRoot({ dataRoot: input })).toBe(resolve(input));
      } finally {
        directory.cleanup();
      }
    });

    it("rejects empty dataRoot", () => {
      expect(() => getDevFlowDataRoot({ dataRoot: "   " })).toThrow(
        "El directorio de datos de DevFlow no puede estar vacío.",
      );
    });

    it("rejects relative dataRoot", () => {
      expect(() => getDevFlowDataRoot({ dataRoot: "relative/root" })).toThrow(
        "El directorio de datos de DevFlow debe ser una ruta absoluta: relative/root",
      );
    });

    it("does not create the directory", () => {
      const directory = createTempDirectory();

      try {
        const target = join(directory.path, "missing-root");
        expect(existsSync(target)).toBe(false);
        expect(getDevFlowDataRoot({ dataRoot: target })).toBe(resolve(target));
        expect(existsSync(target)).toBe(false);
      } finally {
        directory.cleanup();
      }
    });
  });

  describe("valid identifiers", () => {
    it("accepts project-a", () => {
      expect(validatePathIdentifier("projectId", "project-a")).toBe("project-a");
    });

    it("accepts TASK_001", () => {
      expect(validatePathIdentifier("taskId", "TASK_001")).toBe("TASK_001");
    });

    it("accepts run.001", () => {
      expect(validatePathIdentifier("runId", "run.001")).toBe("run.001");
    });

    it("applies trim", () => {
      expect(validatePathIdentifier("projectId", "  project-a  ")).toBe("project-a");
    });

    it("accepts the maximum length of 80 characters", () => {
      const value = `a${"b".repeat(79)}`;
      expect(validatePathIdentifier("taskId", value)).toBe(value);
    });

    it("returns the normalized identifier", () => {
      expect(validatePathIdentifier("runId", "  run-001  ")).toBe("run-001");
    });
  });

  describe("invalid identifiers", () => {
    it("rejects empty", () => {
      expectPathError(
        () => validatePathIdentifier("projectId", ""),
        "El identificador projectId no puede estar vacío.",
        "projectId",
        "",
      );
    });

    it("rejects only spaces", () => {
      expectPathError(
        () => validatePathIdentifier("projectId", "   "),
        "El identificador projectId no puede estar vacío.",
        "projectId",
        "   ",
      );
    });

    it("rejects .", () => {
      expectPathError(
        () => validatePathIdentifier("taskId", "."),
        "El identificador taskId no es seguro para usarlo en una ruta: .",
        "taskId",
        ".",
      );
    });

    it("rejects ..", () => {
      expectPathError(
        () => validatePathIdentifier("taskId", ".."),
        "El identificador taskId no es seguro para usarlo en una ruta: ..",
        "taskId",
        "..",
      );
    });

    it("rejects ../project", () => {
      expectPathError(
        () => validatePathIdentifier("projectId", "../project"),
        "El identificador projectId no es seguro para usarlo en una ruta: ../project",
        "projectId",
        "../project",
      );
    });

    it("rejects project/other", () => {
      expectPathError(
        () => validatePathIdentifier("projectId", "project/other"),
        "El identificador projectId no es seguro para usarlo en una ruta: project/other",
        "projectId",
        "project/other",
      );
    });

    it("rejects project\\other", () => {
      expectPathError(
        () => validatePathIdentifier("projectId", "project\\other"),
        "El identificador projectId no es seguro para usarlo en una ruta: project\\other",
        "projectId",
        "project\\other",
      );
    });

    it("rejects Unix absolute paths", () => {
      expectPathError(
        () => validatePathIdentifier("projectId", "/tmp/project"),
        "El identificador projectId no es seguro para usarlo en una ruta: /tmp/project",
        "projectId",
        "/tmp/project",
      );
    });

    it("rejects platform absolute paths", () => {
      const absolute = resolve("/tmp/platform-project");
      expectPathError(
        () => validatePathIdentifier("projectId", absolute),
        `El identificador projectId no es seguro para usarlo en una ruta: ${absolute}`,
        "projectId",
        absolute,
      );
    });

    it("rejects null byte", () => {
      const value = `project\0other`;
      expectPathError(
        () => validatePathIdentifier("projectId", value),
        `El identificador projectId no es seguro para usarlo en una ruta: ${value}`,
        "projectId",
        value,
      );
    });

    it("rejects identifiers that start with dot", () => {
      expectPathError(
        () => validatePathIdentifier("runId", ".hidden"),
        "El identificador runId no es seguro para usarlo en una ruta: .hidden",
        "runId",
        ".hidden",
      );
    });

    it("rejects internal spaces", () => {
      expectPathError(
        () => validatePathIdentifier("taskId", "TASK 001"),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK 001",
        "taskId",
        "TASK 001",
      );
    });

    it("rejects special characters", () => {
      expectPathError(
        () => validatePathIdentifier("taskId", "TASK:001"),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK:001",
        "taskId",
        "TASK:001",
      );
    });

    it("rejects more than 80 characters", () => {
      const value = `a${"b".repeat(80)}`;
      expectPathError(
        () => validatePathIdentifier("taskId", value),
        "El identificador taskId no puede superar 80 caracteres.",
        "taskId",
        value,
      );
    });

    it("preserves field in DevFlowPathError", () => {
      try {
        validatePathIdentifier("runId", "run id");
      } catch (error) {
        expect((error as DevFlowPathError).field).toBe("runId");
      }
    });

    it("preserves value in DevFlowPathError", () => {
      try {
        validatePathIdentifier("runId", "run id");
      } catch (error) {
        expect((error as DevFlowPathError).value).toBe("run id");
      }
    });

    it("sets the name to DevFlowPathError", () => {
      try {
        validatePathIdentifier("runId", "run id");
      } catch (error) {
        expect((error as DevFlowPathError).name).toBe("DevFlowPathError");
      }
    });
  });

  describe("attempt", () => {
    it("accepts 1", () => {
      expect(validateAttempt(1)).toBe(1);
    });

    it("accepts a larger integer", () => {
      expect(validateAttempt(3)).toBe(3);
    });

    it("rejects 0", () => {
      expect(() => validateAttempt(0)).toThrow("El intento debe ser un entero mayor o igual que 1.");
    });

    it("rejects negative numbers", () => {
      expect(() => validateAttempt(-1)).toThrow("El intento debe ser un entero mayor o igual que 1.");
    });

    it("rejects decimals", () => {
      expect(() => validateAttempt(1.5)).toThrow("El intento debe ser un entero mayor o igual que 1.");
    });

    it("rejects NaN", () => {
      expect(() => validateAttempt(Number.NaN)).toThrow("El intento debe ser un entero mayor o igual que 1.");
    });

    it("rejects Infinity", () => {
      expect(() => validateAttempt(Number.POSITIVE_INFINITY)).toThrow(
        "El intento debe ser un entero mayor o igual que 1.",
      );
    });
  });

  describe("roots", () => {
    it("builds the worktrees root", () => {
      expect(getWorktreesRoot({ dataRoot: "/tmp/devflow-root" })).toBe(resolve("/tmp/devflow-root", "worktrees"));
    });

    it("builds the runs root", () => {
      expect(getRunsRoot({ dataRoot: "/tmp/devflow-root" })).toBe(resolve("/tmp/devflow-root", "runs"));
    });

    it("builds the artifacts root", () => {
      expect(getArtifactsRoot({ dataRoot: "/tmp/devflow-root" })).toBe(resolve("/tmp/devflow-root", "artifacts"));
    });

    it("builds the logs root", () => {
      expect(getLogsRoot({ dataRoot: "/tmp/devflow-root" })).toBe(resolve("/tmp/devflow-root", "logs"));
    });
  });

  describe("workspace path", () => {
    it("builds project-a/TASK-001/1", () => {
      expect(
        getWorkspacePath(
          { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
          { dataRoot: "/tmp/devflow-root" },
        ),
      ).toBe(resolve("/tmp/devflow-root", "worktrees", "project-a", "TASK-001", "1"));
    });

    it("separates two projects", () => {
      const first = getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      const second = getWorkspacePath(
        { projectId: "project-b", taskId: "TASK-001", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      expect(first).not.toBe(second);
    });

    it("separates two tasks", () => {
      const first = getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      const second = getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-002", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      expect(first).not.toBe(second);
    });

    it("separates two attempts", () => {
      const first = getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      const second = getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-001", attempt: 2 },
        { dataRoot: "/tmp/devflow-root" },
      );
      expect(first).not.toBe(second);
    });

    it("rejects unsafe projectId", () => {
      expectPathError(
        () => getWorkspacePath(
          { projectId: "../project-a", taskId: "TASK-001", attempt: 1 },
          { dataRoot: "/tmp/devflow-root" },
        ),
        "El identificador projectId no es seguro para usarlo en una ruta: ../project-a",
        "projectId",
        "../project-a",
      );
    });

    it("rejects unsafe taskId", () => {
      expectPathError(
        () => getWorkspacePath(
          { projectId: "project-a", taskId: "TASK/001", attempt: 1 },
          { dataRoot: "/tmp/devflow-root" },
        ),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK/001",
        "taskId",
        "TASK/001",
      );
    });

    it("rejects invalid attempt", () => {
      expect(() =>
        getWorkspacePath(
          { projectId: "project-a", taskId: "TASK-001", attempt: 0 },
          { dataRoot: "/tmp/devflow-root" },
        ),
      ).toThrow("El intento debe ser un entero mayor o igual que 1.");
    });

    it("stays inside the worktrees root", () => {
      const root = getWorktreesRoot({ dataRoot: "/tmp/devflow-root" });
      const workspace = getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      expectInsideRoot(workspace, root);
    });
  });

  describe("run, artifact and log", () => {
    it("builds the run path", () => {
      expect(
        getRunPath(
          { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
          { dataRoot: "/tmp/devflow-root" },
        ),
      ).toBe(resolve("/tmp/devflow-root", "runs", "project-a", "TASK-001", "run-001"));
    });

    it("builds the artifact path", () => {
      expect(
        getArtifactPath(
          { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
          { dataRoot: "/tmp/devflow-root" },
        ),
      ).toBe(resolve("/tmp/devflow-root", "artifacts", "project-a", "TASK-001", "run-001"));
    });

    it("builds the log path", () => {
      expect(
        getLogPath(
          { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
          { dataRoot: "/tmp/devflow-root" },
        ),
      ).toBe(resolve("/tmp/devflow-root", "logs", "project-a", "TASK-001", "run-001"));
    });

    it("separates two projects with equivalent runId", () => {
      const first = getRunPath(
        { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
        { dataRoot: "/tmp/devflow-root" },
      );
      const second = getRunPath(
        { projectId: "project-b", taskId: "TASK-001", runId: "run-001" },
        { dataRoot: "/tmp/devflow-root" },
      );
      expect(first).not.toBe(second);
    });

    it("separates two tasks", () => {
      const first = getArtifactPath(
        { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
        { dataRoot: "/tmp/devflow-root" },
      );
      const second = getArtifactPath(
        { projectId: "project-a", taskId: "TASK-002", runId: "run-001" },
        { dataRoot: "/tmp/devflow-root" },
      );
      expect(first).not.toBe(second);
    });

    it("separates two runId values", () => {
      const first = getLogPath(
        { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
        { dataRoot: "/tmp/devflow-root" },
      );
      const second = getLogPath(
        { projectId: "project-a", taskId: "TASK-001", runId: "run-002" },
        { dataRoot: "/tmp/devflow-root" },
      );
      expect(first).not.toBe(second);
    });

    it("rejects unsafe runId", () => {
      expectPathError(
        () => getRunPath(
          { projectId: "project-a", taskId: "TASK-001", runId: "run/001" },
          { dataRoot: "/tmp/devflow-root" },
        ),
        "El identificador runId no es seguro para usarlo en una ruta: run/001",
        "runId",
        "run/001",
      );
    });

    it("keeps each path inside its root", () => {
      const options = { dataRoot: "/tmp/devflow-root" };
      const input = { projectId: "project-a", taskId: "TASK-001", runId: "run-001" };

      expectInsideRoot(getRunPath(input, options), getRunsRoot(options));
      expectInsideRoot(getArtifactPath(input, options), getArtifactsRoot(options));
      expectInsideRoot(getLogPath(input, options), getLogsRoot(options));
    });
  });

  describe("isolation", () => {
    it("does not use process.cwd()", () => {
      const cwd = process.cwd();

      getWorkspacePath(
        { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
        { dataRoot: "/tmp/devflow-root" },
      );
      getRunPath(
        { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
        { dataRoot: "/tmp/devflow-root" },
      );

      expect(process.cwd()).toBe(cwd);
    });

    it("does not create directories", () => {
      const directory = createTempDirectory();

      try {
        const root = join(directory.path, "missing-root");
        const nested = join(root, "worktrees", "project-a");

        expect(existsSync(root)).toBe(false);
        getWorkspacePath(
          { projectId: "project-a", taskId: "TASK-001", attempt: 1 },
          { dataRoot: root },
        );
        expect(existsSync(root)).toBe(false);
        expect(existsSync(nested)).toBe(false);
      } finally {
        directory.cleanup();
      }
    });

    it("does not modify the external repository", () => {
      const directory = createTempDirectory();

      try {
        const repositoryPath = directory.path;
        const before = existsSync(join(repositoryPath, "worktrees"));

        getLogPath(
          { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
          { dataRoot: "/tmp/devflow-root" },
        );

        expect(existsSync(join(repositoryPath, "worktrees"))).toBe(before);
      } finally {
        directory.cleanup();
      }
    });

    it("does not access SQLite", () => {
      const directory = createTempDirectory();

      try {
        const sqlitePath = join(directory.path, "devflow.db");
        expect(existsSync(sqlitePath)).toBe(false);

        getArtifactPath(
          { projectId: "project-a", taskId: "TASK-001", runId: "run-001" },
          { dataRoot: directory.path },
        );

        expect(existsSync(sqlitePath)).toBe(false);
      } finally {
        directory.cleanup();
      }
    });
  });
});
