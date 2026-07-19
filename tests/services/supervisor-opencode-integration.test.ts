import { describe, it, expect } from "vitest";

import type { OpenCodeProcessResult } from "../../src/services/opencode-process-runner.js";
import type { AgentEnvelope } from "../../src/services/agent-protocol.js";
import {
  integrateSupervisorOutput,
  SupervisorIntegrationError,
  type SupervisorIntegrationErrorCode,
} from "../../src/services/supervisor-opencode-integration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProcessResult(stdout: string): OpenCodeProcessResult {
  return {
    binaryPath: "opencode",
    args: ["run", "--format", "json", "--dir", "/test", "test prompt"],
    cwd: "/test",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1000,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function textEventJSONL(text: string, messageID = "msg-1"): string {
  return JSON.stringify({
    type: "text",
    timestamp: 1000,
    sessionID: "sess-1",
    part: {
      id: "part-1",
      messageID,
      sessionID: "sess-1",
      type: "text",
      text,
    },
  });
}

function stepFinishJSONL(messageID = "msg-1"): string {
  return JSON.stringify({
    type: "step_finish",
    timestamp: 2000,
    sessionID: "sess-1",
    part: {
      id: "part-2",
      messageID,
      sessionID: "sess-1",
      type: "step-finish",
      reason: "stop",
    },
  });
}

function supervisorEnvelope(overrides: Partial<AgentEnvelope> = {}): AgentEnvelope {
  return {
    protocolVersion: 1,
    role: "supervisor",
    status: "COMPLETED",
    summary: "Tarea analizada correctamente.",
    questions: [],
    risks: [],
    payload: undefined,
    ...overrides,
  };
}

function executableTaskPayload() {
  return {
    classification: "EXECUTABLE_TASK" as const,
    reasoning: "La tarea es clara y acotada.",
    objective: "Implementar feature X",
    context: "El proyecto necesita feature X para el próximo release.",
    acceptanceCriteria: ["Criterio 1", "Criterio 2"],
    allowedPaths: ["src"],
    forbiddenPaths: ["node_modules"],
    requiredCommands: ["npm test"],
    assumptions: ["Node.js disponible"],
    risks: [],
    openQuestions: [],
  };
}

function needsDecompositionPayload() {
  return {
    classification: "NEEDS_DECOMPOSITION" as const,
    reasoning: "La tarea es demasiado amplia.",
    decompositionReason: "La tarea abarca múltiples módulos.",
    suggestedTasks: [
      { title: "Subtarea A", objective: "Hacer A" },
      { title: "Subtarea B", objective: "Hacer B" },
    ],
    openQuestions: ["¿Cuál es el alcance exacto?"],
  };
}

function needsDiscoveryPayload() {
  return {
    classification: "NEEDS_DISCOVERY" as const,
    reasoning: "Falta información crítica.",
    missingInformation: ["Arquitectura actual del sistema"],
    recommendedDiscoveryActions: ["Revisar README", "Explorar src/"],
    openQuestions: ["¿Qué framework se usa?"],
  };
}

function envelopeJSONL(envelope: AgentEnvelope): string {
  return textEventJSONL(JSON.stringify(envelope));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integrateSupervisorOutput", () => {
  describe("happy path — EXECUTABLE_TASK", () => {
    it("returns full pipeline result for valid executable task", () => {
      const envelope = supervisorEnvelope({
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.supervisorResult.classification).toBe("EXECUTABLE_TASK");
      expect(result.supervisorResult.summary).toBe("Tarea analizada correctamente.");
      expect(result.envelope.role).toBe("supervisor");
      expect(result.envelope.status).toBe("COMPLETED");
      expect(result.payload.classification).toBe("EXECUTABLE_TASK");
      expect(result.parsedOutput.sessionID).toBe("sess-1");
      expect(result.parsedOutput.messageID).toBe("msg-1");
    });
  });

  describe("happy path — NEEDS_DECOMPOSITION", () => {
    it("returns full pipeline result for decomposition", () => {
      const envelope = supervisorEnvelope({
        payload: needsDecompositionPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.supervisorResult.classification).toBe("NEEDS_DECOMPOSITION");
      expect(result.supervisorResult.summary).toBe("Tarea analizada correctamente.");
      expect(result.payload.classification).toBe("NEEDS_DECOMPOSITION");
    });
  });

  describe("happy path — NEEDS_DISCOVERY", () => {
    it("returns full pipeline result for discovery", () => {
      const envelope = supervisorEnvelope({
        payload: needsDiscoveryPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.supervisorResult.classification).toBe("NEEDS_DISCOVERY");
      expect(result.supervisorResult.summary).toBe("Tarea analizada correctamente.");
      expect(result.payload.classification).toBe("NEEDS_DISCOVERY");
    });
  });

  describe("intermediate results", () => {
    it("preserves parsedOutput from step 1", () => {
      const envelope = supervisorEnvelope({
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.parsedOutput).toBeDefined();
      expect(result.parsedOutput.events.length).toBeGreaterThanOrEqual(2);
      expect(result.parsedOutput.finished).toBe(true);
    });

    it("preserves envelope from step 2", () => {
      const envelope = supervisorEnvelope({
        payload: executableTaskPayload(),
        questions: ["¿Hay dependencias?"],
        risks: ["Riesgo moderado"],
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.envelope.protocolVersion).toBe(1);
      expect(result.envelope.questions).toEqual(["¿Hay dependencias?"]);
      expect(result.envelope.risks).toEqual(["Riesgo moderado"]);
    });

    it("preserves payload from step 4", () => {
      const envelope = supervisorEnvelope({
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.payload).toBeDefined();
      expect(result.payload.classification).toBe("EXECUTABLE_TASK");
    });
  });

  describe("error — OUTPUT_PARSE_FAILED", () => {
    it("wraps OpenCodeOutputParseError for empty stdout", () => {
      const result = makeProcessResult("");
      expect(() => integrateSupervisorOutput(result)).toThrow(SupervisorIntegrationError);

      try {
        integrateSupervisorOutput(result);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SupervisorIntegrationError);
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("OUTPUT_PARSE_FAILED");
        expect(e.cause).toBeDefined();
        expect(e.message).toContain("No se pudo parsear la salida de OpenCode");
      }
    });

    it("wraps OpenCodeOutputParseError for truncated stdout", () => {
      const result = { ...makeProcessResult("some data"), stdoutTruncated: true };
      expect(() => integrateSupervisorOutput(result)).toThrow(SupervisorIntegrationError);

      try {
        integrateSupervisorOutput(result);
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("OUTPUT_PARSE_FAILED");
      }
    });
  });

  describe("error — ENVELOPE_PARSE_FAILED", () => {
    it("wraps AgentProtocolParseError for invalid JSON in assistant text", () => {
      const stdout = `${textEventJSONL("not valid json")}\n${stepFinishJSONL()}`;
      expect(() => integrateSupervisorOutput(makeProcessResult(stdout))).toThrow(
        SupervisorIntegrationError,
      );

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("ENVELOPE_PARSE_FAILED");
        expect(e.cause).toBeDefined();
        expect(e.message).toContain("No se pudo parsear el envelope del agente");
      }
    });

    it("wraps AgentProtocolParseError for non-object JSON", () => {
      const stdout = `${textEventJSONL('"just a string"')}\n${stepFinishJSONL()}`;
      expect(() => integrateSupervisorOutput(makeProcessResult(stdout))).toThrow(
        SupervisorIntegrationError,
      );

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("ENVELOPE_PARSE_FAILED");
      }
    });
  });

  describe("error — ROLE_MISMATCH", () => {
    it("wraps ROLE_MISMATCH for executor role", () => {
      const envelope = supervisorEnvelope({ role: "executor", payload: executableTaskPayload() });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      expect(() => integrateSupervisorOutput(makeProcessResult(stdout))).toThrow(
        SupervisorIntegrationError,
      );

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("ROLE_MISMATCH");
        expect(e.cause).toBeDefined();
        expect(e.message).toContain("supervisor");
        expect(e.message).toContain("executor");
      }
    });

    it("wraps ROLE_MISMATCH for reviewer role", () => {
      const envelope = supervisorEnvelope({ role: "reviewer", payload: executableTaskPayload() });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("ROLE_MISMATCH");
      }
    });

    it("wraps ROLE_MISMATCH for next-task role", () => {
      const envelope = supervisorEnvelope({ role: "next-task", payload: executableTaskPayload() });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("ROLE_MISMATCH");
      }
    });
  });

  describe("error — PAYLOAD_PARSE_FAILED", () => {
    it("wraps SupervisorPayloadValidationError for invalid payload", () => {
      const envelope = supervisorEnvelope({
        payload: { classification: "INVALID" },
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      expect(() => integrateSupervisorOutput(makeProcessResult(stdout))).toThrow(
        SupervisorIntegrationError,
      );

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("PAYLOAD_PARSE_FAILED");
        expect(e.cause).toBeDefined();
        expect(e.message).toContain("No se pudo parsear el payload del supervisor");
      }
    });

    it("wraps SupervisorPayloadValidationError for missing required fields", () => {
      const envelope = supervisorEnvelope({
        payload: { classification: "EXECUTABLE_TASK" },
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("PAYLOAD_PARSE_FAILED");
      }
    });
  });

  describe("error — SEMANTIC_VALIDATION_FAILED", () => {
    it("wraps SupervisorResultSemanticError for unsafe paths", () => {
      const envelope = supervisorEnvelope({
        payload: {
          ...executableTaskPayload(),
          allowedPaths: ["/absolute/path"],
        },
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      expect(() => integrateSupervisorOutput(makeProcessResult(stdout))).toThrow(
        SupervisorIntegrationError,
      );

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("SEMANTIC_VALIDATION_FAILED");
        expect(e.cause).toBeDefined();
        expect(e.message).toContain("Validación semántica");
      }
    });

    it("wraps SupervisorResultSemanticError for insufficient decomposition", () => {
      const envelope = supervisorEnvelope({
        payload: {
          ...needsDecompositionPayload(),
          suggestedTasks: [{ title: "Only one", objective: "Just one task" }],
        },
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("SEMANTIC_VALIDATION_FAILED");
      }
    });

    it("wraps SupervisorResultSemanticError for conflicting paths", () => {
      const envelope = supervisorEnvelope({
        payload: {
          ...executableTaskPayload(),
          allowedPaths: ["src"],
          forbiddenPaths: ["src"],
        },
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;

      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.code).toBe("SEMANTIC_VALIDATION_FAILED");
      }
    });
  });

  describe("error codes", () => {
    it("has all expected error codes", () => {
      const codes: SupervisorIntegrationErrorCode[] = [
        "OUTPUT_PARSE_FAILED",
        "ENVELOPE_PARSE_FAILED",
        "ROLE_MISMATCH",
        "PAYLOAD_PARSE_FAILED",
        "SEMANTIC_VALIDATION_FAILED",
      ];

      for (const code of codes) {
        expect(code).toBeTruthy();
      }
    });
  });

  describe("status preservation", () => {
    it("preserves NEEDS_INPUT status from envelope", () => {
      const envelope = supervisorEnvelope({
        status: "NEEDS_INPUT",
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.envelope.status).toBe("NEEDS_INPUT");
    });

    it("preserves BLOCKED status from envelope", () => {
      const envelope = supervisorEnvelope({
        status: "BLOCKED",
        payload: needsDiscoveryPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.envelope.status).toBe("BLOCKED");
    });

    it("preserves FAILED status from envelope", () => {
      const envelope = supervisorEnvelope({
        status: "FAILED",
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.envelope.status).toBe("FAILED");
    });
  });

  describe("summary transfer", () => {
    it("transfers envelope summary to result", () => {
      const envelope = supervisorEnvelope({
        summary: "Análisis completo del módulo de autenticación.",
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));

      expect(result.supervisorResult.summary).toBe(
        "Análisis completo del módulo de autenticación.",
      );
    });
  });

  describe("payload field transfer", () => {
    it("transfers EXECUTABLE_TASK fields to result", () => {
      const envelope = supervisorEnvelope({
        payload: executableTaskPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));
      const r = result.supervisorResult;

      expect(r.classification).toBe("EXECUTABLE_TASK");
      expect(r.reasoning).toBe("La tarea es clara y acotada.");
      expect(r.objective).toBe("Implementar feature X");
      expect(r.context).toBe("El proyecto necesita feature X para el próximo release.");
      expect(r.acceptanceCriteria).toEqual(["Criterio 1", "Criterio 2"]);
      expect(r.allowedPaths).toEqual(["src"]);
      expect(r.forbiddenPaths).toEqual(["node_modules"]);
      expect(r.requiredCommands).toEqual(["npm test"]);
      expect(r.assumptions).toEqual(["Node.js disponible"]);
    });

    it("transfers NEEDS_DECOMPOSITION fields to result", () => {
      const envelope = supervisorEnvelope({
        payload: needsDecompositionPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));
      const r = result.supervisorResult;

      expect(r.classification).toBe("NEEDS_DECOMPOSITION");
      expect(r.reasoning).toBe("La tarea es demasiado amplia.");
      expect(r.decompositionReason).toBe("La tarea abarca múltiples módulos.");
      expect(r.suggestedTasks).toHaveLength(2);
      expect(r.suggestedTasks[0].title).toBe("Subtarea A");
      expect(r.openQuestions).toEqual(["¿Cuál es el alcance exacto?"]);
    });

    it("transfers NEEDS_DISCOVERY fields to result", () => {
      const envelope = supervisorEnvelope({
        payload: needsDiscoveryPayload(),
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      const result = integrateSupervisorOutput(makeProcessResult(stdout));
      const r = result.supervisorResult;

      expect(r.classification).toBe("NEEDS_DISCOVERY");
      expect(r.reasoning).toBe("Falta información crítica.");
      expect(r.missingInformation).toEqual(["Arquitectura actual del sistema"]);
      expect(r.recommendedDiscoveryActions).toEqual(["Revisar README", "Explorar src/"]);
      expect(r.openQuestions).toEqual(["¿Qué framework se usa?"]);
    });
  });

  describe("error cause chain", () => {
    it("preserves cause for OUTPUT_PARSE_FAILED", () => {
      try {
        integrateSupervisorOutput(makeProcessResult(""));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.cause).toBeInstanceOf(Error);
      }
    });

    it("preserves cause for ENVELOPE_PARSE_FAILED", () => {
      const stdout = `${textEventJSONL("not json")}\n${stepFinishJSONL()}`;
      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.cause).toBeInstanceOf(Error);
      }
    });

    it("preserves cause for ROLE_MISMATCH", () => {
      const envelope = supervisorEnvelope({ role: "executor" });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.cause).toBeInstanceOf(Error);
      }
    });

    it("preserves cause for PAYLOAD_PARSE_FAILED", () => {
      const envelope = supervisorEnvelope({ payload: { bad: true } });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.cause).toBeInstanceOf(Error);
      }
    });

    it("preserves cause for SEMANTIC_VALIDATION_FAILED", () => {
      const envelope = supervisorEnvelope({
        payload: {
          ...executableTaskPayload(),
          allowedPaths: ["/etc/passwd"],
        },
      });
      const stdout = `${envelopeJSONL(envelope)}\n${stepFinishJSONL()}`;
      try {
        integrateSupervisorOutput(makeProcessResult(stdout));
        expect.fail("Should have thrown");
      } catch (error) {
        const e = error as SupervisorIntegrationError;
        expect(e.cause).toBeInstanceOf(Error);
      }
    });
  });

  describe("error class", () => {
    it("has correct name property", () => {
      try {
        integrateSupervisorOutput(makeProcessResult(""));
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as SupervisorIntegrationError).name).toBe(
          "SupervisorIntegrationError",
        );
      }
    });

    it("is instance of Error", () => {
      try {
        integrateSupervisorOutput(makeProcessResult(""));
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(SupervisorIntegrationError);
      }
    });
  });
});
