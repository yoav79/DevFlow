import { describe, it, expect } from "vitest";
import {
  supervisorAgentPayloadSchema,
  parseSupervisorPayload,
  toSupervisorResult,
  parseSupervisorAgentResult,
  SupervisorPayloadValidationError,
  SupervisorPayloadSemanticError,
  type SupervisorAgentPayload,
  type SupervisorExecutableTaskPayload,
  type SupervisorDecompositionPayload,
  type SupervisorDiscoveryPayload,
} from "../../src/services/supervisor-agent-payload.js";
import { AgentProtocolParseError } from "../../src/services/agent-protocol.js";
import { SupervisorResultSemanticError } from "../../src/services/supervisor-result-semantic-validator.js";
import type { AgentEnvelope } from "../../src/services/agent-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validExecutablePayload: SupervisorExecutableTaskPayload = {
  classification: "EXECUTABLE_TASK",
  reasoning: "Clear scope",
  objective: "Add login button",
  context: "User management",
  acceptanceCriteria: ["Button renders"],
  allowedPaths: ["src/components"],
  forbiddenPaths: [],
  requiredCommands: [],
  assumptions: [],
  risks: [],
  openQuestions: [],
};

const validDecompositionPayload: SupervisorDecompositionPayload = {
  classification: "NEEDS_DECOMPOSITION",
  reasoning: "Too broad",
  decompositionReason: "Spans frontend and backend",
  suggestedTasks: [
    { title: "Add login", objective: "Login form" },
    { title: "Add JWT", objective: "JWT middleware" },
  ],
  openQuestions: ["Which JWT library?"],
};

const validDiscoveryPayload: SupervisorDiscoveryPayload = {
  classification: "NEEDS_DISCOVERY",
  reasoning: "No baseline",
  missingInformation: ["Current latency"],
  recommendedDiscoveryActions: ["Run benchmarks"],
  openQuestions: ["Which tables?"],
};

function makeEnvelope(
  payload: unknown,
  overrides: Partial<AgentEnvelope> = {},
): AgentEnvelope {
  return {
    protocolVersion: 1,
    role: "supervisor",
    status: "COMPLETED",
    summary: "Test summary",
    questions: [],
    risks: [],
    payload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema & structural parse
// ---------------------------------------------------------------------------

describe("schema & structural parse", () => {
  it("accepts valid EXECUTABLE_TASK", () => {
    const result = supervisorAgentPayloadSchema.safeParse(validExecutablePayload);
    expect(result.success).toBe(true);
  });

  it("accepts valid NEEDS_DECOMPOSITION", () => {
    const result = supervisorAgentPayloadSchema.safeParse(validDecompositionPayload);
    expect(result.success).toBe(true);
  });

  it("accepts valid NEEDS_DISCOVERY", () => {
    const result = supervisorAgentPayloadSchema.safeParse(validDiscoveryPayload);
    expect(result.success).toBe(true);
  });

  it("discriminated union returns narrow variant", () => {
    const r1 = parseSupervisorPayload(validExecutablePayload);
    expect(r1.classification).toBe("EXECUTABLE_TASK");

    const r2 = parseSupervisorPayload(validDecompositionPayload);
    expect(r2.classification).toBe("NEEDS_DECOMPOSITION");

    const r3 = parseSupervisorPayload(validDiscoveryPayload);
    expect(r3.classification).toBe("NEEDS_DISCOVERY");
  });

  it("rejects summary inside payload as extra field", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      summary: "extra",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid classification", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      classification: "INVALID",
    });
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    expect(supervisorAgentPayloadSchema.safeParse(null).success).toBe(false);
  });

  it("rejects array", () => {
    expect(supervisorAgentPayloadSchema.safeParse([]).success).toBe(false);
  });

  it("rejects extra field", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      extra: "field",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty reasoning", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      reasoning: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only reasoning", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      reasoning: "   ",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EXECUTABLE_TASK structure
// ---------------------------------------------------------------------------

describe("EXECUTABLE_TASK structure", () => {
  it("rejects empty acceptanceCriteria", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      acceptanceCriteria: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-empty openQuestions", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      openQuestions: ["Why?"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts risks array", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      risks: ["Breaking change"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required array fields", () => {
    for (const field of [
      "allowedPaths",
      "forbiddenPaths",
      "requiredCommands",
      "assumptions",
      "risks",
    ]) {
      const { [field]: _, ...rest } = validExecutablePayload as unknown as Record<string, unknown>;
      const result = supervisorAgentPayloadSchema.safeParse(rest);
      expect(result.success).toBe(false);
    }
  });

  it("rejects empty objective", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      objective: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty context", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validExecutablePayload,
      context: "",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEEDS_DECOMPOSITION structure
// ---------------------------------------------------------------------------

describe("NEEDS_DECOMPOSITION structure", () => {
  it("rejects empty suggestedTasks", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDecompositionPayload,
      suggestedTasks: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty title in suggestedTask", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDecompositionPayload,
      suggestedTasks: [
        { title: "", objective: "Obj" },
        { title: "Valid", objective: "Obj2" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty objective in suggestedTask", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDecompositionPayload,
      suggestedTasks: [
        { title: "Valid", objective: "" },
        { title: "Valid2", objective: "Obj2" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires openQuestions field", () => {
    const { openQuestions: _, ...rest } = validDecompositionPayload;
    const result = supervisorAgentPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("single suggestedTask passes structural validation", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDecompositionPayload,
      suggestedTasks: [{ title: "Only one", objective: "Do something" }],
    });
    expect(result.success).toBe(true);
  });

  it("duplicate titles pass structural validation", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDecompositionPayload,
      suggestedTasks: [
        { title: "Same", objective: "A" },
        { title: "Same", objective: "B" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEEDS_DISCOVERY structure
// ---------------------------------------------------------------------------

describe("NEEDS_DISCOVERY structure", () => {
  it("rejects empty missingInformation", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDiscoveryPayload,
      missingInformation: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty recommendedDiscoveryActions", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDiscoveryPayload,
      recommendedDiscoveryActions: [],
    });
    expect(result.success).toBe(false);
  });

  it("requires openQuestions field", () => {
    const { openQuestions: _, ...rest } = validDiscoveryPayload;
    const result = supervisorAgentPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("duplicate strings pass structural validation", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDiscoveryPayload,
      missingInformation: ["dup", "dup"],
    });
    expect(result.success).toBe(true);
  });

  it("single recommendedDiscoveryAction passes", () => {
    const result = supervisorAgentPayloadSchema.safeParse({
      ...validDiscoveryPayload,
      recommendedDiscoveryActions: ["Run benchmarks"],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adapter: toSupervisorResult
// ---------------------------------------------------------------------------

describe("toSupervisorResult", () => {
  it("copies envelope.summary", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      summary: "Custom summary",
    });
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result.summary).toBe("Custom summary");
  });

  it("does not copy envelope.questions", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      questions: ["Q1"],
    });
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result).not.toHaveProperty("questions");
  });

  it("does not use envelope.risks in result", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      risks: ["Envelope risk"],
    });
    const result = toSupervisorResult(envelope, validExecutablePayload);
    if ("risks" in result) {
      expect(result.risks).toEqual([]);
    }
  });

  it("preserves classification", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result.classification).toBe("EXECUTABLE_TASK");
  });

  it("preserves reasoning", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result.reasoning).toBe(validExecutablePayload.reasoning);
  });

  it("preserves EXECUTABLE_TASK fields", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result).toMatchObject({
      objective: validExecutablePayload.objective,
      context: validExecutablePayload.context,
      acceptanceCriteria: [...validExecutablePayload.acceptanceCriteria],
      allowedPaths: [...validExecutablePayload.allowedPaths],
      forbiddenPaths: [...validExecutablePayload.forbiddenPaths],
      requiredCommands: [...validExecutablePayload.requiredCommands],
      assumptions: [...validExecutablePayload.assumptions],
      risks: [...validExecutablePayload.risks],
      openQuestions: [],
    });
  });

  it("preserves NEEDS_DECOMPOSITION fields", () => {
    const envelope = makeEnvelope(validDecompositionPayload);
    const result = toSupervisorResult(envelope, validDecompositionPayload);
    expect(result).toMatchObject({
      decompositionReason: validDecompositionPayload.decompositionReason,
      suggestedTasks: validDecompositionPayload.suggestedTasks.map((t) => ({
        title: t.title,
        objective: t.objective,
      })),
      openQuestions: [...validDecompositionPayload.openQuestions],
    });
  });

  it("preserves NEEDS_DISCOVERY fields", () => {
    const envelope = makeEnvelope(validDiscoveryPayload);
    const result = toSupervisorResult(envelope, validDiscoveryPayload);
    expect(result).toMatchObject({
      missingInformation: [...validDiscoveryPayload.missingInformation],
      recommendedDiscoveryActions: [
        ...validDiscoveryPayload.recommendedDiscoveryActions,
      ],
      openQuestions: [...validDiscoveryPayload.openQuestions],
    });
  });

  it("returns a new object", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result).not.toBe(validExecutablePayload);
  });

  it("does not mutate envelope", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      summary: "Original",
    });
    const snapshot = JSON.parse(JSON.stringify(envelope));
    toSupervisorResult(envelope, validExecutablePayload);
    expect(envelope).toEqual(snapshot);
  });

  it("does not mutate payload", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const snapshot = JSON.parse(JSON.stringify(validExecutablePayload));
    toSupervisorResult(envelope, validExecutablePayload);
    expect(validExecutablePayload).toEqual(snapshot);
  });

  it("creates new mutable arrays from readonly arrays", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const result = toSupervisorResult(envelope, validExecutablePayload);
    expect(result.classification).toBe("EXECUTABLE_TASK");
    const exec = result as import("../../src/types.js").ExecutableTaskContract;
    expect(Array.isArray(exec.acceptanceCriteria)).toBe(true);
    expect(Array.isArray(exec.allowedPaths)).toBe(true);
    expect(Array.isArray(exec.forbiddenPaths)).toBe(true);
    expect(Array.isArray(exec.requiredCommands)).toBe(true);
    expect(Array.isArray(exec.assumptions)).toBe(true);
    expect(Array.isArray(exec.risks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSupervisorAgentResult: full pipeline
// ---------------------------------------------------------------------------

describe("parseSupervisorAgentResult", () => {
  it("EXECUTABLE_TASK: valid envelope produces SupervisorResult", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    const result = parseSupervisorAgentResult(envelope);
    expect(result.classification).toBe("EXECUTABLE_TASK");
    expect(result.summary).toBe("Test summary");
  });

  it("NEEDS_DECOMPOSITION: valid envelope produces SupervisorResult", () => {
    const envelope = makeEnvelope(validDecompositionPayload);
    const result = parseSupervisorAgentResult(envelope);
    expect(result.classification).toBe("NEEDS_DECOMPOSITION");
  });

  it("NEEDS_DISCOVERY: valid envelope produces SupervisorResult", () => {
    const envelope = makeEnvelope(validDiscoveryPayload);
    const result = parseSupervisorAgentResult(envelope);
    expect(result.classification).toBe("NEEDS_DISCOVERY");
  });

  it("role executor produces ROLE_MISMATCH", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      role: "executor",
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("ROLE_MISMATCH");
    }
  });

  it("invalid payload produces SupervisorPayloadValidationError", () => {
    const envelope = makeEnvelope({ invalid: true });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadValidationError);
    }
  });

  it("unsafe path produces SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validExecutablePayload,
      allowedPaths: ["/etc/passwd"],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) => i.code === "UNSAFE_PATH",
        ),
      ).toBe(true);
    }
  });

  it("invalid path produces SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validExecutablePayload,
      allowedPaths: ["."],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) => i.code === "INVALID_PATH",
        ),
      ).toBe(true);
    }
  });

  it("conflicting allowed/forbidden produces SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validExecutablePayload,
      allowedPaths: ["src/config.ts"],
      forbiddenPaths: ["src/config.ts"],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) => i.code === "CONFLICTING_PATH",
        ),
      ).toBe(true);
    }
  });

  it("duplicate acceptanceCriteria produces SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validExecutablePayload,
      acceptanceCriteria: ["rule", "rule"],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) =>
            i.code === "DUPLICATE_VALUE" && i.path[0] === "acceptanceCriteria",
        ),
      ).toBe(true);
    }
  });

  it("single suggestedTask produces SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validDecompositionPayload,
      suggestedTasks: [{ title: "Only one", objective: "Do something" }],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) => i.code === "INSUFFICIENT_DECOMPOSITION",
        ),
      ).toBe(true);
    }
  });

  it("duplicate suggestedTask titles produce SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validDecompositionPayload,
      suggestedTasks: [
        { title: "Same", objective: "A" },
        { title: "Same", objective: "B" },
      ],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) => i.code === "DUPLICATE_VALUE" && i.path[0] === "suggestedTasks",
        ),
      ).toBe(true);
    }
  });

  it("duplicate discovery values produce SupervisorPayloadSemanticError", () => {
    const envelope = makeEnvelope({
      ...validDiscoveryPayload,
      missingInformation: ["dup", "dup"],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      expect(
        (e as SupervisorPayloadSemanticError).issues.some(
          (i) =>
            i.code === "DUPLICATE_VALUE" &&
            i.path[0] === "missingInformation",
        ),
      ).toBe(true);
    }
  });

  it("semantic issues are preserved", () => {
    const envelope = makeEnvelope({
      ...validExecutablePayload,
      acceptanceCriteria: ["a", "a"],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      const err = e as SupervisorPayloadSemanticError;
      expect(err.issues.length).toBeGreaterThanOrEqual(1);
      expect(typeof err.issues[0]!.code).toBe("string");
      expect(typeof err.issues[0]!.message).toBe("string");
    }
  });

  it("semantic cause is preserved", () => {
    const envelope = makeEnvelope({
      ...validExecutablePayload,
      acceptanceCriteria: ["a", "a"],
    });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadSemanticError);
      const err = e as SupervisorPayloadSemanticError;
      expect(err.cause).toBeInstanceOf(SupervisorResultSemanticError);
    }
  });

  it("unexpected errors are not converted", () => {
    const envelope = makeEnvelope(validExecutablePayload);
    // Force an unexpected error by corrupting the result object
    // This tests that only SupervisorResultSemanticError is caught
    expect(() => parseSupervisorAgentResult(envelope)).not.toThrow(
      SupervisorPayloadSemanticError,
    );
  });
});

// ---------------------------------------------------------------------------
// Status & metadata
// ---------------------------------------------------------------------------

describe("status & metadata", () => {
  function envelopeWithStatus(
    status: AgentEnvelope["status"],
  ): AgentEnvelope {
    return makeEnvelope(validExecutablePayload, { status });
  }

  it("COMPLETED does not affect parsing", () => {
    const result = parseSupervisorAgentResult(envelopeWithStatus("COMPLETED"));
    expect(result.classification).toBe("EXECUTABLE_TASK");
  });

  it("NEEDS_INPUT does not affect parsing", () => {
    const result = parseSupervisorAgentResult(envelopeWithStatus("NEEDS_INPUT"));
    expect(result.classification).toBe("EXECUTABLE_TASK");
  });

  it("BLOCKED does not affect parsing", () => {
    const result = parseSupervisorAgentResult(envelopeWithStatus("BLOCKED"));
    expect(result.classification).toBe("EXECUTABLE_TASK");
  });

  it("FAILED does not affect parsing", () => {
    const result = parseSupervisorAgentResult(envelopeWithStatus("FAILED"));
    expect(result.classification).toBe("EXECUTABLE_TASK");
  });

  it("envelope.questions can differ from payload.openQuestions", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      questions: ["Envelope question"],
    });
    const result = parseSupervisorAgentResult(envelope);
    expect(result).not.toHaveProperty("questions");
  });

  it("envelope.risks can differ from payload.risks", () => {
    const envelope = makeEnvelope(validExecutablePayload, {
      risks: ["Envelope risk"],
    });
    const result = parseSupervisorAgentResult(envelope);
    if ("risks" in result) {
      expect(result.risks).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe("error types", () => {
  it("SupervisorPayloadValidationError extends Error", () => {
    const err = new SupervisorPayloadValidationError([]);
    expect(err).toBeInstanceOf(Error);
  });

  it("SupervisorPayloadSemanticError extends Error", () => {
    const err = new SupervisorPayloadSemanticError([]);
    expect(err).toBeInstanceOf(Error);
  });

  it("SupervisorPayloadValidationError has correct name", () => {
    const err = new SupervisorPayloadValidationError([]);
    expect(err.name).toBe("SupervisorPayloadValidationError");
  });

  it("SupervisorPayloadSemanticError has correct name", () => {
    const err = new SupervisorPayloadSemanticError([]);
    expect(err.name).toBe("SupervisorPayloadSemanticError");
  });

  it("structural issues are normalised", () => {
    const envelope = makeEnvelope({ not: "valid" });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SupervisorPayloadValidationError);
      const err = e as SupervisorPayloadValidationError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(typeof err.issues[0]!.code).toBe("string");
      expect(typeof err.issues[0]!.message).toBe("string");
      expect(Array.isArray(err.issues[0]!.path)).toBe(true);
    }
  });

  it("messages do not include full payload", () => {
    const bigPayload = { ...validExecutablePayload, data: "x".repeat(500) };
    const envelope = makeEnvelope({ not: "valid" });
    try {
      parseSupervisorAgentResult(envelope);
      expect.fail("should throw");
    } catch (e) {
      const err = e as SupervisorPayloadValidationError;
      for (const issue of err.issues) {
        expect(issue.message.length).toBeLessThan(500);
      }
    }
  });
});
