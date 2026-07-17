import { describe, expect, it } from "vitest";
import {
  parseSupervisorResult,
  SupervisorResultValidationError,
} from "../../src/services/supervisor-result-parser.js";
import type { SupervisorResult } from "../../src/types.js";

const validExecutableTask = {
  classification: "EXECUTABLE_TASK",
  summary: "Add login button",
  reasoning: "Clear scope, bounded changes",
  objective: "Add a login button",
  context: "User management page",
  acceptanceCriteria: ["Button renders", "Click opens modal"],
  allowedPaths: ["src/components/"],
  forbiddenPaths: ["src/api/"],
  requiredCommands: ["npm run build"],
  assumptions: [],
  risks: [],
  openQuestions: [],
};

const validDecompositionResult = {
  classification: "NEEDS_DECOMPOSITION",
  summary: "Build auth system",
  reasoning: "Too many components",
  decompositionReason: "Auth spans frontend, backend, DB",
  suggestedTasks: [
    { title: "Add login", objective: "Login form" },
    { title: "Add JWT", objective: "JWT middleware" },
  ],
  openQuestions: ["Which JWT library?"],
};

const validDiscoveryResult = {
  classification: "NEEDS_DISCOVERY",
  summary: "Optimize database",
  reasoning: "No performance baseline",
  missingInformation: ["Current query latency", "Target SLA"],
  recommendedDiscoveryActions: ["Run benchmarks", "Check logs"],
  openQuestions: ["Which tables are slow?"],
};

describe("parseSupervisorResult", () => {
  describe("valid results", () => {
    it("returns a typed EXECUTABLE_TASK", () => {
      const result = parseSupervisorResult(validExecutableTask);
      expect(result.classification).toBe("EXECUTABLE_TASK");
      if (result.classification === "EXECUTABLE_TASK") {
        expect(result.objective).toBe("Add a login button");
      }
    });

    it("returns a typed NEEDS_DECOMPOSITION", () => {
      const result = parseSupervisorResult(validDecompositionResult);
      expect(result.classification).toBe("NEEDS_DECOMPOSITION");
      if (result.classification === "NEEDS_DECOMPOSITION") {
        expect(result.decompositionReason).toBe(
          "Auth spans frontend, backend, DB",
        );
      }
    });

    it("returns a typed NEEDS_DISCOVERY", () => {
      const result = parseSupervisorResult(validDiscoveryResult);
      expect(result.classification).toBe("NEEDS_DISCOVERY");
      if (result.classification === "NEEDS_DISCOVERY") {
        expect(result.missingInformation).toEqual([
          "Current query latency",
          "Target SLA",
        ]);
      }
    });

    it("preserves valid data without normalizing", () => {
      const result = parseSupervisorResult(validExecutableTask);
      expect(result).toEqual(validExecutableTask);
    });

    it("does not modify the input object", () => {
      const input = { ...validExecutableTask };
      const copy = JSON.parse(JSON.stringify(input));
      parseSupervisorResult(input);
      expect(input).toEqual(copy);
    });
  });

  describe("invalid results", () => {
    it("throws for null", () => {
      expect(() => parseSupervisorResult(null)).toThrow(
        SupervisorResultValidationError,
      );
    });

    it("throws for unknown classification", () => {
      expect(() =>
        parseSupervisorResult({ ...validExecutableTask, classification: "UNKNOWN" }),
      ).toThrow(SupervisorResultValidationError);
    });

    it("throws for object without classification", () => {
      expect(() =>
        parseSupervisorResult({ summary: "test", reasoning: "test" }),
      ).toThrow(SupervisorResultValidationError);
    });

    it("throws for EXECUTABLE_TASK without acceptanceCriteria", () => {
      const input = { ...validExecutableTask };
      delete (input as Record<string, unknown>).acceptanceCriteria;
      expect(() => parseSupervisorResult(input)).toThrow(
        SupervisorResultValidationError,
      );
    });

    it("throws for unknown property", () => {
      expect(() =>
        parseSupervisorResult({ ...validExecutableTask, extraField: "value" }),
      ).toThrow(SupervisorResultValidationError);
    });
  });

  describe("error domain", () => {
    it("has name SupervisorResultValidationError", () => {
      try {
        parseSupervisorResult(null);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SupervisorResultValidationError);
        expect((error as SupervisorResultValidationError).name).toBe(
          "SupervisorResultValidationError",
        );
      }
    });

    it("extends Error", () => {
      try {
        parseSupervisorResult(null);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });

    it("message contains the exact number of issues", () => {
      try {
        parseSupervisorResult(null);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultValidationError;
        expect(err.message).toBe(
          "Resultado del supervisor inválido: 1 error(es) de validación.",
        );
      }
    });

    it("issues contain path, code and message", () => {
      try {
        parseSupervisorResult({ summary: "test" });
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultValidationError;
        expect(err.issues.length).toBeGreaterThan(0);
        const issue = err.issues[0];
        expect(issue).toBeDefined();
        expect(issue?.path).toBeDefined();
        expect(issue?.code).toBeDefined();
        expect(issue?.message).toBeDefined();
      }
    });

    it("issue path for invalid objective contains objective", () => {
      try {
        parseSupervisorResult({
          ...validExecutableTask,
          objective: "",
        });
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultValidationError;
        const objectiveIssue = err.issues.find((i) =>
          i.path.includes("objective"),
        );
        expect(objectiveIssue).toBeDefined();
      }
    });

    it("issues array is an independent copy", () => {
      const originalIssues = [
        { path: ["field"], code: "invalid_type", message: "bad" },
      ];
      const error = new SupervisorResultValidationError(originalIssues);
      originalIssues.push({ path: ["other"], code: "extra", message: "extra" });
      expect(error.issues).toHaveLength(1);
    });

    it("path arrays are independent copies", () => {
      const originalPath = ["a", "b"];
      const error = new SupervisorResultValidationError([
        { path: originalPath, code: "test", message: "test" },
      ]);
      originalPath.push("c");
      expect(error.issues[0]?.path).toEqual(["a", "b"]);
    });

    it("modifying the original array after construction does not affect error", () => {
      const issues = [
        { path: ["x"], code: "c1", message: "m1" },
        { path: ["y"], code: "c2", message: "m2" },
      ];
      const error = new SupervisorResultValidationError(issues);
      issues.push({ path: ["z"], code: "c3", message: "m3" });
      expect(error.issues).toHaveLength(2);
    });

    it("two errors do not share mutable arrays", () => {
      const shared = [{ path: ["p"], code: "c", message: "m" }];
      const error1 = new SupervisorResultValidationError(shared);
      const error2 = new SupervisorResultValidationError(shared);
      shared.push({ path: ["q"], code: "d", message: "n" });
      expect(error1.issues).toHaveLength(1);
      expect(error2.issues).toHaveLength(1);
    });
  });

  describe("API surface", () => {
    it("does not expose ZodError to the consumer", () => {
      try {
        parseSupervisorResult(null);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SupervisorResultValidationError);
        expect((error as SupervisorResultValidationError).name).not.toBe(
          "ZodError",
        );
      }
    });

    it("does not return null or undefined for valid input", () => {
      const result = parseSupervisorResult(validExecutableTask);
      expect(result).not.toBeNull();
      expect(result).not.toBeUndefined();
    });

    it("classification narrowing works on return type", () => {
      const result: SupervisorResult = parseSupervisorResult(
        validExecutableTask,
      );
      switch (result.classification) {
        case "EXECUTABLE_TASK":
          expect(typeof result.objective).toBe("string");
          break;
        case "NEEDS_DECOMPOSITION":
          expect(typeof result.decompositionReason).toBe("string");
          break;
        case "NEEDS_DISCOVERY":
          expect(Array.isArray(result.missingInformation)).toBe(true);
          break;
        default: {
          const _exhaustive: never = result;
          expect(_exhaustive).toBeDefined();
        }
      }
    });

    it("can be caught with instanceof", () => {
      try {
        parseSupervisorResult("invalid");
      } catch (error) {
        expect(error instanceof SupervisorResultValidationError).toBe(true);
      }
    });
  });
});
