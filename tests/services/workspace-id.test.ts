import { describe, expect, it } from "vitest";

import { DevFlowPathError } from "../../src/services/devflow-paths.js";
import { WorkspaceIdError, buildWorkspaceId } from "../../src/services/workspace-id.js";

function expectWorkspaceIdError(action: () => unknown, message: string, field?: string, value?: unknown): void {
  try {
    action();
    throw new Error("Expected WorkspaceIdError.");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceIdError);
    expect((error as WorkspaceIdError).message).toBe(message);
    if (field !== undefined) {
      expect((error as WorkspaceIdError).field).toBe(field);
    }
    if (value !== undefined) {
      expect((error as WorkspaceIdError).value).toBe(value);
    }
  }
}

describe("workspace id", () => {
  describe("construction", () => {
    it("builds the expected workspaceId", () => {
      expect(buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 })).toBe(
        "project-a:TASK-001:1",
      );
    });

    it("uses colons as separators", () => {
      const result = buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(result.split(":")).toHaveLength(3);
    });

    it("includes projectId", () => {
      expect(buildWorkspaceId({ projectId: "my-project", taskId: "TASK-001", executionNumber: 1 })).toContain(
        "my-project",
      );
    });

    it("includes taskId", () => {
      expect(buildWorkspaceId({ projectId: "project-a", taskId: "MY-TASK", executionNumber: 1 })).toContain(
        "MY-TASK",
      );
    });

    it("includes executionNumber", () => {
      expect(buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 7 })).toContain("7");
    });

    it("trims projectId", () => {
      expect(buildWorkspaceId({ projectId: "  project-a  ", taskId: "TASK-001", executionNumber: 1 })).toBe(
        "project-a:TASK-001:1",
      );
    });

    it("trims taskId", () => {
      expect(buildWorkspaceId({ projectId: "project-a", taskId: "  TASK-001  ", executionNumber: 1 })).toBe(
        "project-a:TASK-001:1",
      );
    });

    it("preserves case", () => {
      expect(buildWorkspaceId({ projectId: "Project-A", taskId: "Task-001", executionNumber: 1 })).toBe(
        "Project-A:Task-001:1",
      );
    });
  });

  describe("determinism", () => {
    it("same input produces same result", () => {
      const input = { projectId: "project-a", taskId: "TASK-001", executionNumber: 1 };
      expect(buildWorkspaceId(input)).toBe(buildWorkspaceId(input));
    });

    it("different projectId produces different workspaceId", () => {
      const a = buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      const b = buildWorkspaceId({ projectId: "project-b", taskId: "TASK-001", executionNumber: 1 });
      expect(a).not.toBe(b);
    });

    it("different taskId produces different workspaceId", () => {
      const a = buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      const b = buildWorkspaceId({ projectId: "project-a", taskId: "TASK-002", executionNumber: 1 });
      expect(a).not.toBe(b);
    });

    it("different executionNumber produces different workspaceId", () => {
      const a = buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      const b = buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 2 });
      expect(a).not.toBe(b);
    });
  });

  describe("identifiers", () => {
    it("rejects empty projectId", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "", taskId: "TASK-001", executionNumber: 1 }),
        "El identificador projectId no puede estar vacío.",
        "projectId",
        "",
      );
    });

    it("rejects empty taskId", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "", executionNumber: 1 }),
        "El identificador taskId no puede estar vacío.",
        "taskId",
        "",
      );
    });

    it("rejects slash in projectId", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project/a", taskId: "TASK-001", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: project/a",
        "projectId",
        "project/a",
      );
    });

    it("rejects backslash in taskId", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK\\001", executionNumber: 1 }),
        "El identificador taskId no es seguro para usarlo en una ruta: TASK\\001",
        "taskId",
        "TASK\\001",
      );
    });

    it("rejects internal spaces", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project a", taskId: "TASK-001", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: project a",
        "projectId",
        "project a",
      );
    });

    it("rejects path traversal", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "../project", taskId: "TASK-001", executionNumber: 1 }),
        "El identificador projectId no es seguro para usarlo en una ruta: ../project",
        "projectId",
        "../project",
      );
    });

    it("translates DevFlowPathError to WorkspaceIdError", () => {
      try {
        buildWorkspaceId({ projectId: "../project", taskId: "TASK-001", executionNumber: 1 });
        throw new Error("Expected WorkspaceIdError.");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceIdError);
        expect((error as WorkspaceIdError).cause).toBeInstanceOf(DevFlowPathError);
      }
    });

    it("conserves field and value from DevFlowPathError", () => {
      try {
        buildWorkspaceId({ projectId: "../project", taskId: "TASK-001", executionNumber: 1 });
        throw new Error("Expected WorkspaceIdError.");
      } catch (error) {
        expect((error as WorkspaceIdError).field).toBe("projectId");
        expect((error as WorkspaceIdError).value).toBe("../project");
      }
    });
  });

  describe("execution number", () => {
    it("accepts 1", () => {
      expect(buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 })).toBe(
        "project-a:TASK-001:1",
      );
    });

    it("accepts Number.MAX_SAFE_INTEGER", () => {
      expect(
        buildWorkspaceId({
          projectId: "project-a",
          taskId: "TASK-001",
          executionNumber: Number.MAX_SAFE_INTEGER,
        }),
      ).toBe(`project-a:TASK-001:${Number.MAX_SAFE_INTEGER}`);
    });

    it("rejects 0", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 0 }),
        "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        "executionNumber",
        0,
      );
    });

    it("rejects negative", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: -1 }),
        "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        "executionNumber",
        -1,
      );
    });

    it("rejects decimal", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1.5 }),
        "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        "executionNumber",
        1.5,
      );
    });

    it("rejects NaN", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: Number.NaN }),
        "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        "executionNumber",
        Number.NaN,
      );
    });

    it("rejects Infinity", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: Number.POSITIVE_INFINITY }),
        "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        "executionNumber",
        Number.POSITIVE_INFINITY,
      );
    });

    it("rejects MAX_SAFE_INTEGER + 1", () => {
      expectWorkspaceIdError(
        () => buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: Number.MAX_SAFE_INTEGER + 1 }),
        "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        "executionNumber",
        Number.MAX_SAFE_INTEGER + 1,
      );
    });
  });

  describe("error domain", () => {
    it("WorkspaceIdError extends Error", () => {
      const error = new WorkspaceIdError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("name is WorkspaceIdError", () => {
      const error = new WorkspaceIdError("test");
      expect(error.name).toBe("WorkspaceIdError");
    });

    it("uses the exact message for invalid executionNumber", () => {
      try {
        buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 0 });
        throw new Error("Expected WorkspaceIdError.");
      } catch (error) {
        expect((error as WorkspaceIdError).message).toBe(
          "El número de ejecución debe ser un entero seguro mayor o igual que 1.",
        );
      }
    });
  });

  describe("isolation", () => {
    it("does not run Git", () => {
      const cwd = process.cwd();
      buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not access SQLite", () => {
      const cwd = process.cwd();
      buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not use filesystem", () => {
      const cwd = process.cwd();
      buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not use process.cwd()", () => {
      const cwd = process.cwd();
      buildWorkspaceId({ projectId: "project-a", taskId: "TASK-001", executionNumber: 1 });
      expect(process.cwd()).toBe(cwd);
    });

    it("does not modify inputs", () => {
      const input = { projectId: " project-a ", taskId: " TASK-001 ", executionNumber: 1 };
      const snapshot = { ...input };
      buildWorkspaceId(input);
      expect(input).toEqual(snapshot);
    });
  });
});
