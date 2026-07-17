import { describe, expect, it } from "vitest";
import {
  validateSupervisorResultSemantics,
  SupervisorResultSemanticError,
  type SupervisorSemanticIssue,
} from "../../src/services/supervisor-result-semantic-validator.js";
import type {
  SupervisorResult,
  ExecutableTaskContract,
  DecompositionRequiredResult,
  DiscoveryRequiredResult,
} from "../../src/types.js";

const validExecutableTask: ExecutableTaskContract = {
  classification: "EXECUTABLE_TASK",
  summary: "Add login button",
  reasoning: "Clear scope",
  objective: "Add a login button",
  context: "User management page",
  acceptanceCriteria: ["Button renders", "Click opens modal"],
  allowedPaths: ["src/components"],
  forbiddenPaths: ["src/api"],
  requiredCommands: ["npm run build"],
  assumptions: [],
  risks: [],
  openQuestions: [],
};

const validDecompositionResult: DecompositionRequiredResult = {
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

const validDiscoveryResult: DiscoveryRequiredResult = {
  classification: "NEEDS_DISCOVERY",
  summary: "Optimize database",
  reasoning: "No performance baseline",
  missingInformation: ["Current query latency", "Target SLA"],
  recommendedDiscoveryActions: ["Run benchmarks", "Check logs"],
  openQuestions: ["Which tables are slow?"],
};

describe("validateSupervisorResultSemantics", () => {
  describe("general behavior", () => {
    it("returns the same reference for valid EXECUTABLE_TASK", () => {
      const result = validateSupervisorResultSemantics(validExecutableTask);
      expect(result).toBe(validExecutableTask);
    });

    it("returns the same reference for valid NEEDS_DECOMPOSITION", () => {
      const result = validateSupervisorResultSemantics(validDecompositionResult);
      expect(result).toBe(validDecompositionResult);
    });

    it("returns the same reference for valid NEEDS_DISCOVERY", () => {
      const result = validateSupervisorResultSemantics(validDiscoveryResult);
      expect(result).toBe(validDiscoveryResult);
    });

    it("does not modify the valid result", () => {
      const copy = JSON.parse(JSON.stringify(validExecutableTask));
      validateSupervisorResultSemantics(validExecutableTask);
      expect(validExecutableTask).toEqual(copy);
    });

    it("accumulates multiple issues in a single exception", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        acceptanceCriteria: ["a", "a"],
        allowedPaths: ["b", "b"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SupervisorResultSemanticError);
        expect((error as SupervisorResultSemanticError).issues.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("duplicates", () => {
    it("rejects duplicate acceptanceCriteria", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        acceptanceCriteria: ["rule1", "rule1"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "acceptanceCriteria")).toBe(true);
      }
    });

    it("rejects duplicate allowedPaths", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src/", "src/"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "allowedPaths")).toBe(true);
      }
    });

    it("rejects duplicate forbiddenPaths", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        forbiddenPaths: ["src/api/", "src/api/"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "forbiddenPaths")).toBe(true);
      }
    });

    it("rejects duplicate requiredCommands", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        requiredCommands: ["npm test", "npm test"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "requiredCommands")).toBe(true);
      }
    });

    it("rejects duplicate assumptions", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        assumptions: ["dep exists", "dep exists"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "assumptions")).toBe(true);
      }
    });

    it("rejects duplicate risks", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        risks: ["breaking change", "breaking change"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "risks")).toBe(true);
      }
    });

    it("rejects duplicate openQuestions in NEEDS_DISCOVERY", () => {
      const input: DiscoveryRequiredResult = {
        ...validDiscoveryResult,
        openQuestions: ["Which DB?", "Which DB?"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "openQuestions")).toBe(true);
      }
    });

    it("rejects duplicate missingInformation", () => {
      const input: DiscoveryRequiredResult = {
        ...validDiscoveryResult,
        missingInformation: ["latency", "latency"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "missingInformation")).toBe(true);
      }
    });

    it("rejects duplicate recommendedDiscoveryActions", () => {
      const input: DiscoveryRequiredResult = {
        ...validDiscoveryResult,
        recommendedDiscoveryActions: ["run benchmarks", "run benchmarks"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "recommendedDiscoveryActions")).toBe(true);
      }
    });

    it("allows values that differ only in case", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        acceptanceCriteria: ["Rule", "rule"],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("points issue to the index of the second occurrence", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        acceptanceCriteria: ["first", "second", "first"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        const issue = err.issues.find(
          (i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "acceptanceCriteria",
        );
        expect(issue?.path[1]).toBe(2);
      }
    });
  });

  describe("paths", () => {
    it("rejects absolute Unix path", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["/etc/passwd"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "UNSAFE_PATH")).toBe(true);
      }
    });

    it("rejects absolute Windows path with slash", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["C:/Users/test"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "UNSAFE_PATH")).toBe(true);
      }
    });

    it("rejects absolute Windows path with backslash", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["C:\\Users\\test"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "UNSAFE_PATH")).toBe(true);
      }
    });

    it("rejects UNC path", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["\\\\server\\share"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "UNSAFE_PATH")).toBe(true);
      }
    });

    it("rejects path segment ..", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src/../etc/passwd"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "UNSAFE_PATH")).toBe(true);
      }
    });

    it("rejects path exactly .", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["."],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "INVALID_PATH")).toBe(true);
      }
    });

    it("rejects double slash", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src//components"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "INVALID_PATH")).toBe(true);
      }
    });

    it("rejects any backslash", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src\\components"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "INVALID_PATH")).toBe(true);
      }
    });

    it("rejects path ending in slash", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src/components/"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "INVALID_PATH")).toBe(true);
      }
    });

    it("accepts simple relative file", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src/index.ts"],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("accepts relative path with multiple segments", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src/components/Button.tsx"],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("accepts empty allowedPaths", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: [],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("detects exact match between allowedPaths and forbiddenPaths", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src/config.ts"],
        forbiddenPaths: ["src/config.ts"],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "CONFLICTING_PATH")).toBe(true);
      }
    });

    it("does not detect hierarchical overlap yet", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        allowedPaths: ["src"],
        forbiddenPaths: ["src/auth"],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });
  });

  describe("decomposition", () => {
    it("rejects suggestedTasks with single element", () => {
      const input: DecompositionRequiredResult = {
        ...validDecompositionResult,
        suggestedTasks: [{ title: "Only one", objective: "Do something" }],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "INSUFFICIENT_DECOMPOSITION")).toBe(true);
      }
    });

    it("accepts exactly two suggestedTasks", () => {
      const input: DecompositionRequiredResult = {
        ...validDecompositionResult,
        suggestedTasks: [
          { title: "Task A", objective: "Objective A" },
          { title: "Task B", objective: "Objective B" },
        ],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("rejects duplicate titles in suggestedTasks", () => {
      const input: DecompositionRequiredResult = {
        ...validDecompositionResult,
        suggestedTasks: [
          { title: "Add login", objective: "Login form" },
          { title: "Add login", objective: "Duplicate title" },
        ],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "DUPLICATE_VALUE" && String(i.path[0]) === "suggestedTasks")).toBe(true);
      }
    });

    it("allows titles that differ only in case", () => {
      const input: DecompositionRequiredResult = {
        ...validDecompositionResult,
        suggestedTasks: [
          { title: "Add Login", objective: "Login form" },
          { title: "Add login", objective: "Same-ish" },
        ],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("points duplicate title issue to correct index", () => {
      const input: DecompositionRequiredResult = {
        ...validDecompositionResult,
        suggestedTasks: [
          { title: "First", objective: "A" },
          { title: "Second", objective: "B" },
          { title: "First", objective: "C" },
        ],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        const issue = err.issues.find(
          (i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "suggestedTasks",
        );
        expect(issue?.path[1]).toBe(2);
        expect(issue?.path[2]).toBe("title");
      }
    });
  });

  describe("discovery", () => {
    it("accepts empty openQuestions when recommendedDiscoveryActions exist", () => {
      const input: DiscoveryRequiredResult = {
        ...validDiscoveryResult,
        openQuestions: [],
      };
      const result = validateSupervisorResultSemantics(input);
      expect(result).toBe(input);
    });

    it("generates INSUFFICIENT_DISCOVERY when both are empty", () => {
      const input: DiscoveryRequiredResult = {
        classification: "NEEDS_DISCOVERY",
        summary: "test",
        reasoning: "test",
        missingInformation: ["info"],
        recommendedDiscoveryActions: [],
        openQuestions: [],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.issues.some((i) => i.code === "INSUFFICIENT_DISCOVERY")).toBe(true);
      }
    });

    it("does not modify arrays in the result", () => {
      const input: DiscoveryRequiredResult = {
        ...validDiscoveryResult,
        missingInformation: ["a", "b"],
        recommendedDiscoveryActions: ["c", "d"],
        openQuestions: ["e"],
      };
      const mi = [...input.missingInformation];
      const rda = [...input.recommendedDiscoveryActions];
      const oq = [...input.openQuestions];
      validateSupervisorResultSemantics(input);
      expect(input.missingInformation).toEqual(mi);
      expect(input.recommendedDiscoveryActions).toEqual(rda);
      expect(input.openQuestions).toEqual(oq);
    });
  });

  describe("error domain", () => {
    it("has name SupervisorResultSemanticError", () => {
      try {
        validateSupervisorResultSemantics({
          ...validExecutableTask,
          acceptanceCriteria: ["a", "a"],
        });
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SupervisorResultSemanticError);
        expect((error as SupervisorResultSemanticError).name).toBe(
          "SupervisorResultSemanticError",
        );
      }
    });

    it("extends Error", () => {
      try {
        validateSupervisorResultSemantics({
          ...validExecutableTask,
          acceptanceCriteria: ["a", "a"],
        });
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });

    it("message contains exact number of issues", () => {
      try {
        validateSupervisorResultSemantics({
          ...validExecutableTask,
          acceptanceCriteria: ["a", "a"],
          allowedPaths: ["b", "b"],
        });
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        expect(err.message).toBe(
          "Resultado del supervisor semánticamente inválido: 2 error(es).",
        );
      }
    });

    it("defensively copies the issues array", () => {
      const issues: SupervisorSemanticIssue[] = [
        { code: "DUPLICATE_VALUE", path: ["acceptanceCriteria", 1], message: "dup" },
      ];
      const error = new SupervisorResultSemanticError(issues);
      issues.push({ code: "UNSAFE_PATH", path: ["allowedPaths", 0], message: "unsafe" });
      expect(error.issues).toHaveLength(1);
    });

    it("defensively copies each path", () => {
      const path = ["allowedPaths", 0];
      const error = new SupervisorResultSemanticError([
        { code: "INVALID_PATH", path, message: "bad" },
      ]);
      path.push(99);
      expect(error.issues[0]?.path).toEqual(["allowedPaths", 0]);
    });

    it("modifying inputs after construction does not alter error.issues", () => {
      const input = [
        { code: "DUPLICATE_VALUE" as const, path: ["a", 1] as Array<string | number>, message: "m1" },
      ];
      const error = new SupervisorResultSemanticError(input);
      input[0]?.path.push(99);
      input[0] && (input[0].message = "changed");
      expect(error.issues[0]?.message).toBe("m1");
      expect(error.issues[0]?.path).toEqual(["a", 1]);
    });

    it("two errors do not share mutable arrays", () => {
      const shared: SupervisorSemanticIssue[] = [
        { code: "DUPLICATE_VALUE", path: ["x"], message: "m" },
      ];
      const e1 = new SupervisorResultSemanticError(shared);
      const e2 = new SupervisorResultSemanticError(shared);
      shared.push({ code: "UNSAFE_PATH", path: ["y"], message: "n" });
      expect(e1.issues).toHaveLength(1);
      expect(e2.issues).toHaveLength(1);
    });

    it("codes belong to SupervisorSemanticIssueCode", () => {
      const validCodes = new Set([
        "DUPLICATE_VALUE",
        "UNSAFE_PATH",
        "CONFLICTING_PATH",
        "INVALID_PATH",
        "INSUFFICIENT_DISCOVERY",
        "INSUFFICIENT_DECOMPOSITION",
      ]);
      try {
        validateSupervisorResultSemantics({
          ...validExecutableTask,
          acceptanceCriteria: ["a", "a"],
          allowedPaths: ["."],
        });
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        for (const issue of err.issues) {
          expect(validCodes.has(issue.code)).toBe(true);
        }
      }
    });

    it("issues maintain deterministic order", () => {
      const input: ExecutableTaskContract = {
        ...validExecutableTask,
        acceptanceCriteria: ["a", "a"],
        allowedPaths: ["."],
      };
      try {
        validateSupervisorResultSemantics(input);
        expect.fail("should throw");
      } catch (error) {
        const err = error as SupervisorResultSemanticError;
        const codes = err.issues.map((i) => i.code);
        expect(codes).toEqual(["DUPLICATE_VALUE", "INVALID_PATH"]);
      }
    });
  });
});
