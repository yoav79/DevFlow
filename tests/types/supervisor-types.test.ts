import { describe, expect, it } from "vitest";
import {
  SUPERVISOR_CLASSIFICATIONS,
  type SupervisorResult,
} from "../../src/types.js";

function describeSupervisorResult(result: SupervisorResult): string {
  switch (result.classification) {
    case "EXECUTABLE_TASK":
      return result.objective;
    case "NEEDS_DECOMPOSITION":
      return result.decompositionReason;
    case "NEEDS_DISCOVERY":
      return result.missingInformation.join(", ");
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

describe("Supervisor domain types", () => {
  it("contains exactly three classifications", () => {
    expect(SUPERVISOR_CLASSIFICATIONS).toHaveLength(3);
  });

  it("has classifications in the correct order", () => {
    expect(SUPERVISOR_CLASSIFICATIONS).toEqual([
      "EXECUTABLE_TASK",
      "NEEDS_DECOMPOSITION",
      "NEEDS_DISCOVERY",
    ]);
  });

  it("has no duplicate values", () => {
    const unique = new Set(SUPERVISOR_CLASSIFICATIONS);
    expect(unique.size).toBe(SUPERVISOR_CLASSIFICATIONS.length);
  });

  it("returns objective for EXECUTABLE_TASK", () => {
    const result: SupervisorResult = {
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

    expect(describeSupervisorResult(result)).toBe("Add a login button");
  });

  it("returns decompositionReason for NEEDS_DECOMPOSITION", () => {
    const result: SupervisorResult = {
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

    expect(describeSupervisorResult(result)).toBe(
      "Auth spans frontend, backend, DB",
    );
  });

  it("returns missingInformation for NEEDS_DISCOVERY", () => {
    const result: SupervisorResult = {
      classification: "NEEDS_DISCOVERY",
      summary: "Optimize database",
      reasoning: "No performance baseline",
      missingInformation: ["Current query latency", "Target SLA"],
      recommendedDiscoveryActions: ["Run benchmarks", "Check logs"],
      openQuestions: ["Which tables are slow?"],
    };

    expect(describeSupervisorResult(result)).toBe(
      "Current query latency, Target SLA",
    );
  });
});
