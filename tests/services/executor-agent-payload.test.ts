import { describe, expect, it } from "vitest";

import {
  executorAgentPayloadSchema,
  parseExecutorPayload,
  parseExecutorAgentResult,
  ExecutorPayloadValidationError,
  ExecutorPayloadSemanticError,
  type ExecutorAgentPayload,
} from "../../src/services/executor-agent-payload.js";
import { AgentProtocolParseError } from "../../src/services/agent-protocol.js";
import type { AgentEnvelope } from "../../src/services/agent-protocol.js";

const minimalPayload: ExecutorAgentPayload = {
  filesClaimed: [],
  commandsClaimed: [],
};

function makeEnvelope(
  payload: unknown,
  overrides: Partial<AgentEnvelope> = {},
): AgentEnvelope {
  return {
    protocolVersion: 1,
    role: "executor",
    status: "COMPLETED",
    summary: "Executor summary",
    questions: [],
    risks: [],
    payload,
    ...overrides,
  };
}

describe("executorAgentPayloadSchema", () => {
  it("accepts the minimal payload with empty arrays", () => {
    const result = executorAgentPayloadSchema.safeParse(minimalPayload);
    expect(result.success).toBe(true);
  });

  it("accepts a payload with one file and one command", () => {
    const result = executorAgentPayloadSchema.safeParse({
      filesClaimed: ["src/app.ts"],
      commandsClaimed: ["npm test"],
    });
    expect(result.success).toBe(true);
  });

  it("preserves order and exact values for valid strings", () => {
    const payload = parseExecutorPayload({
      filesClaimed: ["src/a.ts", " src/b.ts "],
      commandsClaimed: ["npm test", " npm run build "],
    });

    expect(payload.filesClaimed).toEqual(["src/a.ts", " src/b.ts "]);
    expect(payload.commandsClaimed).toEqual(["npm test", " npm run build "]);
  });

  it("rejects missing filesClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({ commandsClaimed: [] }).success,
    ).toBe(false);
  });

  it("rejects missing commandsClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({ filesClaimed: [] }).success,
    ).toBe(false);
  });

  it("rejects null root payload", () => {
    expect(executorAgentPayloadSchema.safeParse(null).success).toBe(false);
  });

  it("rejects array root payload", () => {
    expect(executorAgentPayloadSchema.safeParse([]).success).toBe(false);
  });

  it("rejects string root payload", () => {
    expect(executorAgentPayloadSchema.safeParse("payload").success).toBe(false);
  });

  it("rejects number root payload", () => {
    expect(executorAgentPayloadSchema.safeParse(42).success).toBe(false);
  });

  it("rejects filesClaimed when it is not an array", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: "src/a.ts",
        commandsClaimed: [],
      }).success,
    ).toBe(false);
  });

  it("rejects commandsClaimed when it is not an array", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: [],
        commandsClaimed: "npm test",
      }).success,
    ).toBe(false);
  });

  it("rejects non-string elements in filesClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: ["src/a.ts", 1],
        commandsClaimed: [],
      }).success,
    ).toBe(false);
  });

  it("rejects non-string elements in commandsClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: [],
        commandsClaimed: ["npm test", 1],
      }).success,
    ).toBe(false);
  });

  it("rejects empty strings in filesClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: [""],
        commandsClaimed: [],
      }).success,
    ).toBe(false);
  });

  it("rejects whitespace-only strings in filesClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: ["   "],
        commandsClaimed: [],
      }).success,
    ).toBe(false);
  });

  it("rejects empty strings in commandsClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: [],
        commandsClaimed: [""],
      }).success,
    ).toBe(false);
  });

  it("rejects whitespace-only strings in commandsClaimed", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: [],
        commandsClaimed: ["   "],
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(
      executorAgentPayloadSchema.safeParse({
        filesClaimed: [],
        commandsClaimed: [],
        summary: "extra",
      }).success,
    ).toBe(false);
  });
});

describe("parseExecutorPayload", () => {
  it("returns the minimal payload", () => {
    expect(parseExecutorPayload(minimalPayload)).toEqual(minimalPayload);
  });

  it("preserves multiple values in original order", () => {
    const payload = parseExecutorPayload({
      filesClaimed: ["src/b.ts", "src/a.ts", "src/c.ts"],
      commandsClaimed: ["npm run lint", "npm test", "npm run build"],
    });

    expect(payload.filesClaimed).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
    expect(payload.commandsClaimed).toEqual(["npm run lint", "npm test", "npm run build"]);
  });

  it("produces ExecutorPayloadValidationError for invalid structure", () => {
    expect(() =>
      parseExecutorPayload({ filesClaimed: [], commandsClaimed: [""] }),
    ).toThrow(ExecutorPayloadValidationError);
  });

  it("rejects duplicate filesClaimed", () => {
    expect(() =>
      parseExecutorPayload({
        filesClaimed: ["src/a.ts", "src/a.ts"],
        commandsClaimed: [],
      }),
    ).toThrow(ExecutorPayloadSemanticError);
  });

  it("rejects duplicate commandsClaimed", () => {
    expect(() =>
      parseExecutorPayload({
        filesClaimed: [],
        commandsClaimed: ["npm test", "npm test"],
      }),
    ).toThrow(ExecutorPayloadSemanticError);
  });

  it("reports multiple duplicate issues with correct paths", () => {
    try {
      parseExecutorPayload({
        filesClaimed: ["src/a.ts", "src/a.ts", "src/a.ts"],
        commandsClaimed: ["npm test", "npm test"],
      });
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutorPayloadSemanticError);
      const parsed = error as ExecutorPayloadSemanticError;
      expect(parsed.issues).toEqual([
        {
          path: ["filesClaimed", 1],
          code: "DUPLICATE_VALUE",
          message: "Valor duplicado en filesClaimed: src/a.ts. Ya apareció previamente.",
        },
        {
          path: ["filesClaimed", 2],
          code: "DUPLICATE_VALUE",
          message: "Valor duplicado en filesClaimed: src/a.ts. Ya apareció previamente.",
        },
        {
          path: ["commandsClaimed", 1],
          code: "DUPLICATE_VALUE",
          message: "Valor duplicado en commandsClaimed: npm test. Ya apareció previamente.",
        },
      ]);
    }
  });

  it("allows the same string once in each array", () => {
    const payload = parseExecutorPayload({
      filesClaimed: ["npm test"],
      commandsClaimed: ["npm test"],
    });
    expect(payload.filesClaimed).toEqual(["npm test"]);
    expect(payload.commandsClaimed).toEqual(["npm test"]);
  });

  it("arrays vacíos are semantically valid", () => {
    expect(parseExecutorPayload(minimalPayload)).toEqual(minimalPayload);
  });

  it("validation issues contain path, code and message", () => {
    try {
      parseExecutorPayload({ filesClaimed: [], commandsClaimed: [""] });
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutorPayloadValidationError);
      const parsed = error as ExecutorPayloadValidationError;
      expect(parsed.name).toBe("ExecutorPayloadValidationError");
      expect(parsed.issues.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.issues[0]!.path)).toBe(true);
      expect(typeof parsed.issues[0]!.code).toBe("string");
      expect(typeof parsed.issues[0]!.message).toBe("string");
    }
  });

  it("semantic issues use DUPLICATE_VALUE code", () => {
    try {
      parseExecutorPayload({
        filesClaimed: ["src/a.ts", "src/a.ts"],
        commandsClaimed: [],
      });
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutorPayloadSemanticError);
      const parsed = error as ExecutorPayloadSemanticError;
      expect(parsed.name).toBe("ExecutorPayloadSemanticError");
      expect(parsed.issues[0]!.code).toBe("DUPLICATE_VALUE");
    }
  });
});

describe("parseExecutorAgentResult", () => {
  it("parses a valid envelope with role executor", () => {
    const result = parseExecutorAgentResult(
      makeEnvelope({
        filesClaimed: ["src/app.ts"],
        commandsClaimed: ["npm test"],
      }),
    );

    expect(result).toEqual({
      filesClaimed: ["src/app.ts"],
      commandsClaimed: ["npm test"],
    });
  });

  it("role supervisor produces ROLE_MISMATCH", () => {
    expect(() =>
      parseExecutorAgentResult(
        makeEnvelope(minimalPayload, { role: "supervisor" }),
      ),
    ).toThrow(AgentProtocolParseError);
  });

  it("COMPLETED does not affect parsing", () => {
    const result = parseExecutorAgentResult(
      makeEnvelope(minimalPayload, { status: "COMPLETED" }),
    );
    expect(result).toEqual(minimalPayload);
  });

  it("NEEDS_INPUT does not affect parsing", () => {
    const result = parseExecutorAgentResult(
      makeEnvelope(minimalPayload, { status: "NEEDS_INPUT" }),
    );
    expect(result).toEqual(minimalPayload);
  });

  it("BLOCKED does not affect parsing", () => {
    const result = parseExecutorAgentResult(
      makeEnvelope(minimalPayload, { status: "BLOCKED" }),
    );
    expect(result).toEqual(minimalPayload);
  });

  it("FAILED does not affect parsing", () => {
    const result = parseExecutorAgentResult(
      makeEnvelope(minimalPayload, { status: "FAILED" }),
    );
    expect(result).toEqual(minimalPayload);
  });

  it("propagates ExecutorPayloadValidationError", () => {
    expect(() =>
      parseExecutorAgentResult(
        makeEnvelope({ filesClaimed: [], commandsClaimed: [""] }),
      ),
    ).toThrow(ExecutorPayloadValidationError);
  });

  it("propagates ExecutorPayloadSemanticError", () => {
    expect(() =>
      parseExecutorAgentResult(
        makeEnvelope({
          filesClaimed: ["src/a.ts", "src/a.ts"],
          commandsClaimed: [],
        }),
      ),
    ).toThrow(ExecutorPayloadSemanticError);
  });
});

describe("immutability", () => {
  it("parseExecutorPayload does not mutate the input object or arrays", () => {
    const payload = {
      filesClaimed: ["src/a.ts", "src/b.ts"],
      commandsClaimed: ["npm test", "npm run build"],
    };
    const snapshot = JSON.parse(JSON.stringify(payload));

    parseExecutorPayload(payload);

    expect(payload).toEqual(snapshot);
  });

  it("parseExecutorAgentResult does not mutate the envelope", () => {
    const envelope = makeEnvelope({
      filesClaimed: ["src/a.ts"],
      commandsClaimed: ["npm test"],
    });
    const snapshot = JSON.parse(JSON.stringify(envelope));

    parseExecutorAgentResult(envelope);

    expect(envelope).toEqual(snapshot);
  });
});
