import { describe, it, expect } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_ROLES,
  AGENT_PROTOCOL_STATUSES,
  agentRoleSchema,
  agentProtocolStatusSchema,
  agentEnvelopeSchema,
  parseAgentEnvelope,
  assertAgentEnvelopeRole,
  AgentProtocolParseError,
  type AgentEnvelope,
  type AgentRole,
} from "../../src/services/agent-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEnvelope(
  overrides: Partial<AgentEnvelope> = {},
): AgentEnvelope {
  return {
    protocolVersion: 1,
    role: "supervisor",
    status: "COMPLETED",
    summary: "Test summary",
    questions: [],
    risks: [],
    payload: null,
    ...overrides,
  };
}

function envelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      protocolVersion: 1,
      role: "supervisor",
      status: "COMPLETED",
      summary: "Test summary",
      questions: [],
      risks: [],
      payload: null,
      ...overrides,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("protocol version is 1", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(1);
  });

  it("roles are exact and in order", () => {
    expect(AGENT_ROLES).toEqual([
      "supervisor",
      "executor",
      "reviewer",
      "next-task",
    ]);
  });

  it("statuses are exact and in order", () => {
    expect(AGENT_PROTOCOL_STATUSES).toEqual([
      "COMPLETED",
      "NEEDS_INPUT",
      "BLOCKED",
      "FAILED",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Schema: valid envelopes
// ---------------------------------------------------------------------------

describe("agentEnvelopeSchema - valid envelopes", () => {
  it("accepts supervisor envelope", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope());
    expect(result.success).toBe(true);
  });

  it("accepts executor envelope", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ role: "executor" }));
    expect(result.success).toBe(true);
  });

  it("accepts reviewer envelope", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ role: "reviewer" }));
    expect(result.success).toBe(true);
  });

  it("accepts next-task envelope", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ role: "next-task" }));
    expect(result.success).toBe(true);
  });

  it("accepts each status", () => {
    for (const status of AGENT_PROTOCOL_STATUSES) {
      const result = agentEnvelopeSchema.safeParse(validEnvelope({ status }));
      expect(result.success).toBe(true);
    }
  });

  it("accepts empty questions", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ questions: [] }));
    expect(result.success).toBe(true);
  });

  it("accepts empty risks", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ risks: [] }));
    expect(result.success).toBe(true);
  });

  it("accepts payload as object", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ payload: { foo: "bar" } }));
    expect(result.success).toBe(true);
  });

  it("accepts payload as array", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ payload: [1, 2, 3] }));
    expect(result.success).toBe(true);
  });

  it("accepts payload as null", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ payload: null }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema: invalid payloads
// ---------------------------------------------------------------------------

describe("agentEnvelopeSchema - payload policy", () => {
  it("rejects missing payload", () => {
    const result = agentEnvelopeSchema.safeParse({
      protocolVersion: 1,
      role: "supervisor",
      status: "COMPLETED",
      summary: "Test",
      questions: [],
      risks: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects explicit undefined payload via schema", () => {
    // undefined gets stripped by JSON.parse, but direct schema usage should reject
    const result = agentEnvelopeSchema.safeParse({
      protocolVersion: 1,
      role: "supervisor",
      status: "COMPLETED",
      summary: "Test",
      questions: [],
      risks: [],
      payload: undefined,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema: invalid envelopes
// ---------------------------------------------------------------------------

describe("agentEnvelopeSchema - invalid envelopes", () => {
  it("rejects null", () => {
    const result = agentEnvelopeSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects array", () => {
    const result = agentEnvelopeSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("rejects string", () => {
    const result = agentEnvelopeSchema.safeParse("hello");
    expect(result.success).toBe(false);
  });

  it("rejects number", () => {
    const result = agentEnvelopeSchema.safeParse(42);
    expect(result.success).toBe(false);
  });

  it("rejects object without protocolVersion", () => {
    const result = agentEnvelopeSchema.safeParse({
      role: "supervisor",
      status: "COMPLETED",
      summary: "Test",
      questions: [],
      risks: [],
      payload: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const result = agentEnvelopeSchema.safeParse(
      validEnvelope({ role: "invalid-role" as AgentRole }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const result = agentEnvelopeSchema.safeParse(
      validEnvelope({ status: "INVALID" as never }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty summary", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ summary: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only summary", () => {
    const result = agentEnvelopeSchema.safeParse(validEnvelope({ summary: "   " }));
    expect(result.success).toBe(false);
  });

  it("rejects questions as non-array", () => {
    const result = agentEnvelopeSchema.safeParse(
      validEnvelope({ questions: "not-array" as never }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects questions with empty string", () => {
    const result = agentEnvelopeSchema.safeParse(
      validEnvelope({ questions: ["valid", ""] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects risks as non-array", () => {
    const result = agentEnvelopeSchema.safeParse(
      validEnvelope({ risks: "not-array" as never }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects risks with whitespace", () => {
    const result = agentEnvelopeSchema.safeParse(
      validEnvelope({ risks: ["valid", "   "] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects additional properties", () => {
    const result = agentEnvelopeSchema.safeParse({
      ...validEnvelope(),
      extraField: "should not be here",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAgentEnvelope: JSON handling
// ---------------------------------------------------------------------------

describe("parseAgentEnvelope - JSON handling", () => {
  it("returns EMPTY_ASSISTANT_TEXT for empty string", () => {
    expect(() => parseAgentEnvelope("")).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope("");
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("EMPTY_ASSISTANT_TEXT");
    }
  });

  it("returns EMPTY_ASSISTANT_TEXT for whitespace-only string", () => {
    expect(() => parseAgentEnvelope("   \n\t  ")).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope("   \n\t  ");
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("EMPTY_ASSISTANT_TEXT");
    }
  });

  it("returns INVALID_JSON for syntactically invalid JSON", () => {
    expect(() => parseAgentEnvelope("{not json}")).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope("{not json}");
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("INVALID_JSON");
    }
  });

  it("returns INVALID_JSON for markdown fence", () => {
    const text = '```json\n{"protocolVersion":1,"role":"supervisor","status":"COMPLETED","summary":"Test","questions":[],"risks":[],"payload":null}\n```';
    expect(() => parseAgentEnvelope(text)).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(text);
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("INVALID_JSON");
    }
  });

  it("returns INVALID_JSON for text before JSON", () => {
    const json = envelopeJson();
    expect(() => parseAgentEnvelope(`prefix ${json}`)).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(`prefix ${json}`);
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("INVALID_JSON");
    }
  });

  it("returns INVALID_JSON for text after JSON", () => {
    const json = envelopeJson();
    expect(() => parseAgentEnvelope(`${json} suffix`)).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(`${json} suffix`);
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("INVALID_JSON");
    }
  });

  it("returns INVALID_JSON for multiple concatenated objects", () => {
    const json = envelopeJson();
    expect(() => parseAgentEnvelope(`${json}${json}`)).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(`${json}${json}`);
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("INVALID_JSON");
    }
  });

  it("accepts whitespace around valid JSON", () => {
    const json = envelopeJson();
    const result = parseAgentEnvelope(`  \n${json}\n  `);
    expect(result.protocolVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseAgentEnvelope: version errors
// ---------------------------------------------------------------------------

describe("parseAgentEnvelope - version errors", () => {
  it("returns UNSUPPORTED_PROTOCOL_VERSION for version 2", () => {
    expect(() =>
      parseAgentEnvelope(envelopeJson({ protocolVersion: 2 })),
    ).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(envelopeJson({ protocolVersion: 2 }));
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
    }
  });

  it("returns UNSUPPORTED_PROTOCOL_VERSION for string version", () => {
    expect(() =>
      parseAgentEnvelope(envelopeJson({ protocolVersion: "1" })),
    ).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(envelopeJson({ protocolVersion: "1" }));
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
    }
  });

  it("returns UNSUPPORTED_PROTOCOL_VERSION for null version", () => {
    expect(() =>
      parseAgentEnvelope(envelopeJson({ protocolVersion: null })),
    ).toThrow(AgentProtocolParseError);
    try {
      parseAgentEnvelope(envelopeJson({ protocolVersion: null }));
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
    }
  });

  it("version error preserves issues", () => {
    try {
      parseAgentEnvelope(envelopeJson({ protocolVersion: 2 }));
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      const err = e as AgentProtocolParseError;
      expect(err.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
      expect(err.issues).toBeDefined();
      expect(err.issues!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// parseAgentEnvelope: envelope errors
// ---------------------------------------------------------------------------

describe("parseAgentEnvelope - envelope errors", () => {
  it("returns INVALID_ENVELOPE for null JSON", () => {
    try {
      parseAgentEnvelope("null");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
    }
  });

  it("returns INVALID_ENVELOPE for array JSON", () => {
    try {
      parseAgentEnvelope("[]");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
    }
  });

  it("returns INVALID_ENVELOPE for string JSON", () => {
    try {
      parseAgentEnvelope('"hello"');
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
    }
  });

  it("returns INVALID_ENVELOPE for number JSON", () => {
    try {
      parseAgentEnvelope("42");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
    }
  });

  it("returns INVALID_ENVELOPE for missing protocolVersion", () => {
    const json = envelopeJson();
    const parsed = JSON.parse(json);
    delete parsed.protocolVersion;
    try {
      parseAgentEnvelope(JSON.stringify(parsed));
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
    }
  });

  it("returns INVALID_ENVELOPE for missing payload", () => {
    const json = envelopeJson();
    const parsed = JSON.parse(json);
    delete parsed.payload;
    try {
      parseAgentEnvelope(JSON.stringify(parsed));
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProtocolParseError);
      expect((e as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
    }
  });

  it("exposes normalised issues for INVALID_ENVELOPE", () => {
    try {
      parseAgentEnvelope("null");
      expect.fail("should throw");
    } catch (e) {
      const err = e as AgentProtocolParseError;
      expect(err.code).toBe("INVALID_ENVELOPE");
      expect(err.issues).toBeDefined();
      expect(Array.isArray(err.issues)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseAgentEnvelope: successful parsing
// ---------------------------------------------------------------------------

describe("parseAgentEnvelope - success", () => {
  it("parses valid supervisor envelope", () => {
    const result = parseAgentEnvelope(envelopeJson());
    expect(result.protocolVersion).toBe(1);
    expect(result.role).toBe("supervisor");
    expect(result.status).toBe("COMPLETED");
    expect(result.summary).toBe("Test summary");
    expect(result.questions).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.payload).toBeNull();
  });

  it("parses executor envelope with payload", () => {
    const json = envelopeJson({ role: "executor", payload: { files: ["a.ts"] } });
    const result = parseAgentEnvelope(json);
    expect(result.role).toBe("executor");
    expect(result.payload).toEqual({ files: ["a.ts"] });
  });

  it("parses reviewer envelope", () => {
    const result = parseAgentEnvelope(envelopeJson({ role: "reviewer" }));
    expect(result.role).toBe("reviewer");
  });

  it("parses next-task envelope", () => {
    const result = parseAgentEnvelope(envelopeJson({ role: "next-task" }));
    expect(result.role).toBe("next-task");
  });

  it("parses each status", () => {
    for (const status of AGENT_PROTOCOL_STATUSES) {
      const result = parseAgentEnvelope(envelopeJson({ status }));
      expect(result.status).toBe(status);
    }
  });

  it("parses questions and risks", () => {
    const json = envelopeJson({
      questions: ["What?", "Why?"],
      risks: ["Low confidence"],
    });
    const result = parseAgentEnvelope(json);
    expect(result.questions).toEqual(["What?", "Why?"]);
    expect(result.risks).toEqual(["Low confidence"]);
  });
});

// ---------------------------------------------------------------------------
// assertAgentEnvelopeRole
// ---------------------------------------------------------------------------

describe("assertAgentEnvelopeRole", () => {
  it("returns same reference for matching role", () => {
    const envelope = validEnvelope({ role: "supervisor" });
    const result = assertAgentEnvelopeRole(envelope, "supervisor");
    expect(result).toBe(envelope);
  });

  it("throws ROLE_MISMATCH for mismatched role", () => {
    const envelope = validEnvelope({ role: "executor" });
    expect(() => assertAgentEnvelopeRole(envelope, "supervisor")).toThrow(
      AgentProtocolParseError,
    );
    try {
      assertAgentEnvelopeRole(envelope, "supervisor");
    } catch (e) {
      expect((e as AgentProtocolParseError).code).toBe("ROLE_MISMATCH");
    }
  });

  it("error contains expectedRole", () => {
    const envelope = validEnvelope({ role: "executor" });
    try {
      assertAgentEnvelopeRole(envelope, "supervisor");
      expect.fail("should throw");
    } catch (e) {
      expect((e as AgentProtocolParseError).expectedRole).toBe("supervisor");
    }
  });

  it("error contains receivedRole", () => {
    const envelope = validEnvelope({ role: "executor" });
    try {
      assertAgentEnvelopeRole(envelope, "supervisor");
      expect.fail("should throw");
    } catch (e) {
      expect((e as AgentProtocolParseError).receivedRole).toBe("executor");
    }
  });
});

// ---------------------------------------------------------------------------
// AgentProtocolParseError
// ---------------------------------------------------------------------------

describe("AgentProtocolParseError", () => {
  it("extends Error", () => {
    const err = new AgentProtocolParseError("test", { code: "EMPTY_ASSISTANT_TEXT" });
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct name", () => {
    const err = new AgentProtocolParseError("test", { code: "EMPTY_ASSISTANT_TEXT" });
    expect(err.name).toBe("AgentProtocolParseError");
  });

  it("preserves cause for INVALID_JSON", () => {
    const cause = new Error("Unexpected token");
    const err = new AgentProtocolParseError("bad json", {
      code: "INVALID_JSON",
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it("messages do not contain full assistantText", () => {
    const longText = "x".repeat(1000);
    try {
      parseAgentEnvelope(longText);
      expect.fail("should throw");
    } catch (e) {
      const err = e as AgentProtocolParseError;
      expect(err.message.length).toBeLessThan(longText.length);
      expect(err.message).not.toContain(longText);
    }
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("immutability", () => {
  it("parseAgentEnvelope does not mutate input string", () => {
    const input = envelopeJson();
    const original = input.slice();
    parseAgentEnvelope(input);
    expect(input).toBe(original);
  });

  it("assertAgentEnvelopeRole does not mutate envelope", () => {
    const envelope = validEnvelope({ role: "supervisor" });
    const snapshot = JSON.parse(JSON.stringify(envelope));
    assertAgentEnvelopeRole(envelope, "supervisor");
    expect(envelope).toEqual(snapshot);
  });
});
