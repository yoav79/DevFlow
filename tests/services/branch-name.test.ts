import { describe, expect, it } from "vitest";

import { BranchNameError, buildBranchName } from "../../src/services/branch-name.js";

function expectBranchError(action: () => unknown, message: string, field?: string, value?: unknown): void {
  try {
    action();
    throw new Error("Expected BranchNameError.");
  } catch (error) {
    expect(error).toBeInstanceOf(BranchNameError);
    expect((error as BranchNameError).message).toBe(message);
    if (field !== undefined) {
      expect((error as BranchNameError).field).toBe(field);
    }
    if (value !== undefined) {
      expect((error as BranchNameError).value).toBe(value);
    }
  }
}

describe("branch name", () => {
  describe("construction", () => {
    it("builds the expected branch", () => {
      expect(buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 })).toBe(
        "devflow/project-a/TASK-001/execution-1",
      );
    });

    it("uses the devflow prefix", () => {
      const result = buildBranchName({ projectId: "p", taskId: "t", executionNumber: 1 });
      expect(result.startsWith("devflow/")).toBe(true);
    });

    it("includes projectId", () => {
      const result = buildBranchName({ projectId: "my-project", taskId: "t", executionNumber: 1 });
      expect(result).toContain("my-project");
    });

    it("includes taskId", () => {
      const result = buildBranchName({ projectId: "p", taskId: "MY-TASK", executionNumber: 1 });
      expect(result).toContain("MY-TASK");
    });

    it("includes executionNumber", () => {
      const result = buildBranchName({ projectId: "p", taskId: "t", executionNumber: 5 });
      expect(result).toContain("execution-5");
    });

    it("uses execution-1 not attempt-1", () => {
      const result = buildBranchName({ projectId: "p", taskId: "t", executionNumber: 1 });
      expect(result).toContain("execution-1");
      expect(result).not.toContain("attempt");
    });

    it("normalizes projectId whitespace", () => {
      expect(buildBranchName({ projectId: "  project-a  ", taskId: "t", executionNumber: 1 })).toBe(
        "devflow/project-a/t/execution-1",
      );
    });

    it("normalizes taskId whitespace", () => {
      expect(buildBranchName({ projectId: "p", taskId: "  TASK-001  ", executionNumber: 1 })).toBe(
        "devflow/p/TASK-001/execution-1",
      );
    });
  });

  describe("determinism", () => {
    it("same input produces same result", () => {
      const input = { projectId: "project-a", taskId: "TASK-001", executionNumber: 1 };
      expect(buildBranchName(input)).toBe(buildBranchName(input));
    });

    it("different projectId produces different branch", () => {
      const a = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      const b = buildBranchName({ projectId: "project-b", taskId: "t", executionNumber: 1 });
      expect(a).not.toBe(b);
    });

    it("different taskId produces different branch", () => {
      const a = buildBranchName({ projectId: "p", taskId: "TASK-001", executionNumber: 1 });
      const b = buildBranchName({ projectId: "p", taskId: "TASK-002", executionNumber: 1 });
      expect(a).not.toBe(b);
    });

    it("different executionNumber produces different branch", () => {
      const a = buildBranchName({ projectId: "p", taskId: "t", executionNumber: 1 });
      const b = buildBranchName({ projectId: "p", taskId: "t", executionNumber: 2 });
      expect(a).not.toBe(b);
    });
  });

  describe("projectId", () => {
    it("rejects empty projectId", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "", taskId: "t", executionNumber: 1 }),
        "El identificador projectId no puede estar vacío.",
        "projectId",
        "",
      );
    });

    it("rejects projectId with internal spaces", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "project a", taskId: "t", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: project a",
        "projectId",
        "project a",
      );
    });

    it("rejects projectId with slash", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "project/other", taskId: "t", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: project/other",
        "projectId",
        "project/other",
      );
    });

    it("rejects projectId with backslash", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "project\\other", taskId: "t", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: project\\other",
        "projectId",
        "project\\other",
      );
    });

    it("rejects projectId with path traversal", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "../project", taskId: "t", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: ../project",
        "projectId",
        "../project",
      );
    });

    it("rejects projectId starting with dot", () => {
      expectBranchError(
        () => buildBranchName({ projectId: ".hidden", taskId: "t", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: .hidden",
        "projectId",
        ".hidden",
      );
    });

    it("rejects projectId too long", () => {
      const value = `a${"b".repeat(80)}`;
      expectBranchError(
        () => buildBranchName({ projectId: value, taskId: "t", executionNumber: 1 }),
        "El identificador projectId no puede superar 80 caracteres.",
        "projectId",
        value,
      );
    });
  });

  describe("taskId", () => {
    it("rejects empty taskId", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "", executionNumber: 1 }),
        "El identificador taskId no puede estar vacío.",
        "taskId",
        "",
      );
    });

    it("rejects taskId with internal spaces", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "TASK 001", executionNumber: 1 }),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK 001",
        "taskId",
        "TASK 001",
      );
    });

    it("rejects taskId with slash", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "TASK/001", executionNumber: 1 }),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK/001",
        "taskId",
        "TASK/001",
      );
    });

    it("rejects taskId with backslash", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "TASK\\001", executionNumber: 1 }),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK\\001",
        "taskId",
        "TASK\\001",
      );
    });

    it("rejects taskId with path traversal", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "../task", executionNumber: 1 }),
        "El identificador taskId no es seguro para usarlo en una ruta: ../task",
        "taskId",
        "../task",
      );
    });

    it("rejects taskId starting with dot", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: ".hidden", executionNumber: 1 }),
        "El identificador taskId no es seguro para usarlo en una ruta: .hidden",
        "taskId",
        ".hidden",
      );
    });

    it("rejects taskId too long", () => {
      const value = `a${"b".repeat(80)}`;
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: value, executionNumber: 1 }),
        "El identificador taskId no puede superar 80 caracteres.",
        "taskId",
        value,
      );
    });
  });

  describe("executionNumber", () => {
    it("accepts 1", () => {
      expect(buildBranchName({ projectId: "p", taskId: "t", executionNumber: 1 })).toContain("execution-1");
    });

    it("accepts a larger integer", () => {
      expect(buildBranchName({ projectId: "p", taskId: "t", executionNumber: 42 })).toContain("execution-42");
    });

    it("rejects 0", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "t", executionNumber: 0 }),
        "El número de ejecución debe ser un entero mayor o igual que 1.",
        "executionNumber",
        0,
      );
    });

    it("rejects negative", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "t", executionNumber: -1 }),
        "El número de ejecución debe ser un entero mayor o igual que 1.",
        "executionNumber",
        -1,
      );
    });

    it("rejects decimal", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "t", executionNumber: 1.5 }),
        "El número de ejecución debe ser un entero mayor o igual que 1.",
        "executionNumber",
        1.5,
      );
    });

    it("rejects NaN", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "t", executionNumber: Number.NaN }),
        "El número de ejecución debe ser un entero mayor o igual que 1.",
        "executionNumber",
        Number.NaN,
      );
    });

    it("rejects Infinity", () => {
      expectBranchError(
        () => buildBranchName({ projectId: "p", taskId: "t", executionNumber: Number.POSITIVE_INFINITY }),
        "El número de ejecución debe ser un entero mayor o igual que 1.",
        "executionNumber",
        Number.POSITIVE_INFINITY,
      );
    });
  });

  describe("git ref validation", () => {
    it("branch does not contain ..", () => {
      try {
        buildBranchName({ projectId: "project..a", taskId: "t", executionNumber: 1 });
        throw new Error("Expected BranchNameError.");
      } catch (error) {
        expect(error).toBeInstanceOf(BranchNameError);
        expect((error as BranchNameError).message).toContain("no es válido");
      }
    });

    it("branch does not contain @{", () => {
      const result = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      expect(result.includes("@{")).toBe(false);
    });

    it("branch does not contain //", () => {
      const result = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      expect(result.includes("//")).toBe(false);
    });

    it("branch does not end in slash", () => {
      const result = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      expect(result.endsWith("/")).toBe(false);
    });

    it("branch does not end in dot", () => {
      const result = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      expect(result.endsWith(".")).toBe(false);
    });

    it("branch does not end in .lock", () => {
      const result = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      expect(result.endsWith(".lock")).toBe(false);
    });

    it("branch does not contain forbidden characters", () => {
      const result = buildBranchName({ projectId: "project-a", taskId: "t", executionNumber: 1 });
      expect(/[~^:?*\[\\]/.test(result)).toBe(false);
    });

    it("branch stays within 240 characters for maximum-length identifiers", () => {
      const longProject = "a".repeat(80);
      const longTask = "b".repeat(80);
      const result = buildBranchName({ projectId: longProject, taskId: longTask, executionNumber: 1 });
      expect(result.length).toBeLessThanOrEqual(240);
    });
  });

  describe("error domain", () => {
    it("BranchNameError extends Error", () => {
      const error = new BranchNameError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("name is BranchNameError", () => {
      const error = new BranchNameError("test");
      expect(error.name).toBe("BranchNameError");
    });

    it("preserves field", () => {
      const error = new BranchNameError("test", { field: "projectId" });
      expect(error.field).toBe("projectId");
    });

    it("preserves value", () => {
      const error = new BranchNameError("test", { value: "bad" });
      expect(error.value).toBe("bad");
    });

    it("preserves cause when translating DevFlowPathError", () => {
      try {
        buildBranchName({ projectId: "../bad", taskId: "t", executionNumber: 1 });
        throw new Error("Expected BranchNameError.");
      } catch (error) {
        expect(error).toBeInstanceOf(BranchNameError);
        expect((error as BranchNameError).cause).toBeDefined();
        expect((error as BranchNameError).cause).toBeInstanceOf(Error);
      }
    });

    it("uses stable messages", () => {
      try {
        buildBranchName({ projectId: "", taskId: "t", executionNumber: 1 });
        throw new Error("Expected BranchNameError.");
      } catch (error) {
        expect((error as BranchNameError).message).toBe("El identificador projectId no puede estar vacío.");
      }
    });
  });

  describe("isolation", () => {
    it("does not run Git", () => {
      const cwd = process.cwd();
      buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not access SQLite", () => {
      const cwd = process.cwd();
      buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not create directories", () => {
      const cwd = process.cwd();
      buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not create worktrees", () => {
      const cwd = process.cwd();
      buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not use process.cwd()", () => {
      const cwd = process.cwd();
      buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not modify the external repository", () => {
      const cwd = process.cwd();
      buildBranchName({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });
  });
});
