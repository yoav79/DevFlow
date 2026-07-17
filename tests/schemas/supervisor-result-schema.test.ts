import { describe, expect, it } from "vitest";
import {
  supervisorClassificationSchema,
  executableTaskContractSchema,
  decompositionRequiredResultSchema,
  discoveryRequiredResultSchema,
  supervisorResultSchema,
} from "../../src/schemas/supervisor-result-schema.js";

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

describe("supervisorClassificationSchema", () => {
  it("accepts the three valid classifications", () => {
    expect(supervisorClassificationSchema.safeParse("EXECUTABLE_TASK").success).toBe(true);
    expect(supervisorClassificationSchema.safeParse("NEEDS_DECOMPOSITION").success).toBe(true);
    expect(supervisorClassificationSchema.safeParse("NEEDS_DISCOVERY").success).toBe(true);
  });

  it("rejects an unknown classification", () => {
    const result = supervisorClassificationSchema.safeParse("UNKNOWN");
    expect(result.success).toBe(false);
  });
});

describe("executableTaskContractSchema", () => {
  it("accepts a complete valid contract", () => {
    const result = executableTaskContractSchema.safeParse(validExecutableTask);
    expect(result.success).toBe(true);
  });

  it("accepts empty allowedPaths", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      allowedPaths: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty arrays where the type allows empty", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      forbiddenPaths: [],
      requiredCommands: [],
      assumptions: [],
      risks: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty acceptanceCriteria", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      acceptanceCriteria: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("acceptanceCriteria");
    }
  });

  it("rejects openQuestions with elements", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      openQuestions: ["What database?"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("openQuestions");
    }
  });

  it("rejects empty objective", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      objective: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects objective composed only of spaces", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      objective: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      unknownProp: "value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a different classification with executable fields", () => {
    const result = executableTaskContractSchema.safeParse({
      ...validExecutableTask,
      classification: "NEEDS_DECOMPOSITION",
    });
    expect(result.success).toBe(false);
  });
});

describe("decompositionRequiredResultSchema", () => {
  it("accepts a valid decomposition result", () => {
    const result = decompositionRequiredResultSchema.safeParse(validDecompositionResult);
    expect(result.success).toBe(true);
  });

  it("rejects empty suggestedTasks", () => {
    const result = decompositionRequiredResultSchema.safeParse({
      ...validDecompositionResult,
      suggestedTasks: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("suggestedTasks");
    }
  });

  it("rejects suggestedTask with empty title", () => {
    const result = decompositionRequiredResultSchema.safeParse({
      ...validDecompositionResult,
      suggestedTasks: [{ title: "", objective: "Login form" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("title");
    }
  });

  it("rejects fields exclusive to EXECUTABLE_TASK", () => {
    const result = decompositionRequiredResultSchema.safeParse({
      ...validDecompositionResult,
      objective: "Should not be here",
    });
    expect(result.success).toBe(false);
  });
});

describe("discoveryRequiredResultSchema", () => {
  it("accepts a valid discovery result", () => {
    const result = discoveryRequiredResultSchema.safeParse(validDiscoveryResult);
    expect(result.success).toBe(true);
  });

  it("rejects empty missingInformation", () => {
    const result = discoveryRequiredResultSchema.safeParse({
      ...validDiscoveryResult,
      missingInformation: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("missingInformation");
    }
  });

  it("rejects empty recommendedDiscoveryActions", () => {
    const result = discoveryRequiredResultSchema.safeParse({
      ...validDiscoveryResult,
      recommendedDiscoveryActions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("recommendedDiscoveryActions");
    }
  });

  it("rejects fields exclusive to NEEDS_DECOMPOSITION", () => {
    const result = discoveryRequiredResultSchema.safeParse({
      ...validDiscoveryResult,
      decompositionReason: "Should not be here",
    });
    expect(result.success).toBe(false);
  });
});

describe("supervisorResultSchema", () => {
  it("returns the correct variant for EXECUTABLE_TASK", () => {
    const result = supervisorResultSchema.safeParse(validExecutableTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("EXECUTABLE_TASK");
      expect("objective" in result.data).toBe(true);
    }
  });

  it("returns the correct variant for NEEDS_DECOMPOSITION", () => {
    const result = supervisorResultSchema.safeParse(validDecompositionResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("NEEDS_DECOMPOSITION");
      expect("decompositionReason" in result.data).toBe(true);
    }
  });

  it("returns the correct variant for NEEDS_DISCOVERY", () => {
    const result = supervisorResultSchema.safeParse(validDiscoveryResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe("NEEDS_DISCOVERY");
      expect("missingInformation" in result.data).toBe(true);
    }
  });

  it("rejects an object without classification", () => {
    const result = supervisorResultSchema.safeParse({
      summary: "test",
      reasoning: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    expect(supervisorResultSchema.safeParse(null).success).toBe(false);
  });

  it("rejects an array", () => {
    expect(supervisorResultSchema.safeParse([]).success).toBe(false);
  });

  it("rejects a string", () => {
    expect(supervisorResultSchema.safeParse("hello").success).toBe(false);
  });

  it("rejects unknown properties in any variant", () => {
    const result = supervisorResultSchema.safeParse({
      ...validExecutableTask,
      extraField: "value",
    });
    expect(result.success).toBe(false);
  });
});
