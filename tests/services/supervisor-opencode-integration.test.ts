import { describe, expect, it } from "vitest";

import type { AgentEnvelope } from "../../src/services/agent-protocol.js";
import { AgentProtocolParseError } from "../../src/services/agent-protocol.js";
import type { OpenCodeProcessResult } from "../../src/services/opencode-process-runner.js";
import { OpenCodeOutputParseError } from "../../src/services/opencode-output-parser.js";
import {
  interpretSupervisorOpenCodeResult,
  SupervisorOpenCodeInterpretationError,
  type SupervisorOpenCodeInterpretationErrorCode,
} from "../../src/services/supervisor-opencode-integration.js";
import {
  SupervisorPayloadSemanticError,
  SupervisorPayloadValidationError,
} from "../../src/services/supervisor-agent-payload.js";

function makeProcessResult(stdout: string, overrides: Partial<OpenCodeProcessResult> = {}): OpenCodeProcessResult {
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
    ...overrides,
  };
}

function textEventJSONL(text: string, messageID = "msg-1", sessionID = "sess-1"): string {
  return JSON.stringify({
    type: "text",
    timestamp: 1000,
    sessionID,
    part: {
      id: "part-1",
      messageID,
      sessionID,
      type: "text",
      text,
    },
  });
}

function stepFinishJSONL(messageID = "msg-1", sessionID = "sess-1"): string {
  return JSON.stringify({
    type: "step_finish",
    timestamp: 2000,
    sessionID,
    part: {
      id: "part-2",
      messageID,
      sessionID,
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
    payload: null,
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

function envelopeJSONL(envelope: AgentEnvelope, messageID = "msg-1", sessionID = "sess-1"): string {
  return textEventJSONL(JSON.stringify(envelope), messageID, sessionID);
}

function validStdout(envelope: AgentEnvelope, messageID = "msg-1", sessionID = "sess-1"): string {
  return `${envelopeJSONL(envelope, messageID, sessionID)}\n${stepFinishJSONL(messageID, sessionID)}`;
}

function expectInterpretationError(
  fn: () => unknown,
  code: SupervisorOpenCodeInterpretationErrorCode,
): SupervisorOpenCodeInterpretationError {
  try {
    fn();
    expect.fail("Should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(SupervisorOpenCodeInterpretationError);
    const typed = error as SupervisorOpenCodeInterpretationError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

describe("interpretSupervisorOpenCodeResult", () => {
  describe("happy path", () => {
    it("accepts EXECUTABLE_TASK válido", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }))),
      );

      expect(result.supervisorResult.classification).toBe("EXECUTABLE_TASK");
      expect(result.supervisorResult.summary).toBe("Tarea analizada correctamente.");
    });

    it("accepts NEEDS_DECOMPOSITION válido", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: needsDecompositionPayload() }))),
      );

      expect(result.supervisorResult.classification).toBe("NEEDS_DECOMPOSITION");
    });

    it("accepts NEEDS_DISCOVERY válido", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: needsDiscoveryPayload() }))),
      );

      expect(result.supervisorResult.classification).toBe("NEEDS_DISCOVERY");
    });

    it("devuelve sessionID", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }), "msg-22", "sess-99")),
      );

      expect(result.sessionID).toBe("sess-99");
    });

    it("devuelve messageID", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }), "msg-22", "sess-99")),
      );

      expect(result.messageID).toBe("msg-22");
    });

    it("no devuelve parsedOutput", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }))),
      ) as unknown as Record<string, unknown>;

      expect(result).not.toHaveProperty("parsedOutput");
    });

    it("no devuelve envelope", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }))),
      ) as unknown as Record<string, unknown>;

      expect(result).not.toHaveProperty("envelope");
    });

    it("no devuelve payload", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }))),
      ) as unknown as Record<string, unknown>;

      expect(result).not.toHaveProperty("payload");
    });
  });

  describe("process guards", () => {
    it("exitCode no cero -> PROCESS_EXIT_NOT_ZERO", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), { exitCode: 2 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.exitCode).toBe(2);
    });

    it("exitCode null -> PROCESS_EXIT_UNKNOWN", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), { exitCode: null })),
        "PROCESS_EXIT_UNKNOWN",
      );

      expect(error.exitCode).toBeNull();
    });

    it("signal no nula -> PROCESS_SIGNALED", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), { signal: "SIGTERM" })),
        "PROCESS_SIGNALED",
      );

      expect(error.signal).toBe("SIGTERM");
    });

    it("timeout -> OUTPUT_PARSE_FAILED", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("anything", { timedOut: true, signal: "SIGTERM", exitCode: null })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.cause).toBeInstanceOf(OpenCodeOutputParseError);
    });

    it("abort -> OUTPUT_PARSE_FAILED", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("anything", { aborted: true, signal: "SIGTERM", exitCode: null })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.cause).toBeInstanceOf(OpenCodeOutputParseError);
    });

    it("stdoutTruncated -> OUTPUT_PARSE_FAILED", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("anything", { stdoutTruncated: true, exitCode: 9 })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.cause).toBeInstanceOf(OpenCodeOutputParseError);
    });

    it("timeout tiene precedencia sobre signal", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("anything", { timedOut: true, signal: "SIGTERM" })),
        "OUTPUT_PARSE_FAILED",
      );
    });

    it("abort tiene precedencia sobre signal", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("anything", { aborted: true, signal: "SIGTERM" })),
        "OUTPUT_PARSE_FAILED",
      );
    });

    it("stdoutTruncated tiene precedencia sobre non-zero exit", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("anything", { stdoutTruncated: true, exitCode: 17 })),
        "OUTPUT_PARSE_FAILED",
      );
    });

    it("signal tiene precedencia sobre exitCode null", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), { signal: "SIGTERM", exitCode: null })),
        "PROCESS_SIGNALED",
      );
    });

    it("exitCode null tiene precedencia sobre non-zero si fixture lo representa", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), { exitCode: null })),
        "PROCESS_EXIT_UNKNOWN",
      );
    });
  });

  describe("output", () => {
    it("stdout vacío -> OUTPUT_PARSE_FAILED", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("")),
        "OUTPUT_PARSE_FAILED",
      );
    });

    it("JSONL inválido -> OUTPUT_PARSE_FAILED", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("NOT JSON")),
        "OUTPUT_PARSE_FAILED",
      );
    });

    it("ausencia de assistant text -> OUTPUT_PARSE_FAILED", () => {
      const stdout = stepFinishJSONL();
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "OUTPUT_PARSE_FAILED",
      );
    });

    it("finished false -> OUTPUT_NOT_FINISHED", () => {
      const stdout = envelopeJSONL(supervisorEnvelope({ payload: executableTaskPayload() }));
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "OUTPUT_NOT_FINISHED",
      );
    });
  });

  describe("protocol", () => {
    it("assistantText JSON inválido -> PROTOCOL_PARSE_FAILED", () => {
      const stdout = `${textEventJSONL("not valid json")}\n${stepFinishJSONL()}`;
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "PROTOCOL_PARSE_FAILED",
      );

      expect(error.cause).toBeInstanceOf(AgentProtocolParseError);
    });

    it("envelope inválido -> PROTOCOL_PARSE_FAILED", () => {
      const invalidEnvelope = {
        protocolVersion: 1,
        role: "supervisor",
        status: "COMPLETED",
        summary: "ok",
        questions: [],
        risks: [],
      };
      const stdout = `${textEventJSONL(JSON.stringify(invalidEnvelope))}\n${stepFinishJSONL()}`;
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "PROTOCOL_PARSE_FAILED",
      );
    });

    it("role incorrecto -> ROLE_MISMATCH", () => {
      const stdout = validStdout(
        supervisorEnvelope({ role: "executor", payload: executableTaskPayload() }),
      );
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "ROLE_MISMATCH",
      );
    });
  });

  describe("payload", () => {
    it("payload estructural inválido -> SUPERVISOR_PAYLOAD_INVALID", () => {
      const stdout = validStdout(
        supervisorEnvelope({ payload: { classification: "INVALID" } }),
      );
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "SUPERVISOR_PAYLOAD_INVALID",
      );

      expect(error.cause).toBeInstanceOf(SupervisorPayloadValidationError);
    });

    it("payload semántico inválido -> SUPERVISOR_PAYLOAD_SEMANTIC_ERROR", () => {
      const stdout = validStdout(
        supervisorEnvelope({
          payload: {
            ...executableTaskPayload(),
            allowedPaths: ["/absolute/path"],
          },
        }),
      );
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "SUPERVISOR_PAYLOAD_SEMANTIC_ERROR",
      );

      expect(error.cause).toBeInstanceOf(SupervisorPayloadSemanticError);
    });
  });

  describe("status", () => {
    it("COMPLETED se acepta", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ status: "COMPLETED", payload: executableTaskPayload() }))),
      );

      expect(result.supervisorResult.classification).toBe("EXECUTABLE_TASK");
    });

    it("NEEDS_INPUT se rechaza", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ status: "NEEDS_INPUT", payload: executableTaskPayload() })))),
        "AGENT_STATUS_NOT_ACCEPTED",
      );
    });

    it("BLOCKED se rechaza", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ status: "BLOCKED", payload: executableTaskPayload() })))),
        "AGENT_STATUS_NOT_ACCEPTED",
      );
    });

    it("FAILED se rechaza", () => {
      expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(validStdout(supervisorEnvelope({ status: "FAILED", payload: executableTaskPayload() })))),
        "AGENT_STATUS_NOT_ACCEPTED",
      );
    });
  });

  describe("stderr", () => {
    it("stderr no vacío no bloquea éxito", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), {
          stderr: "warning: rate limited",
        }),
      );

      expect(result.supervisorResult.classification).toBe("EXECUTABLE_TASK");
    });

    it("stderrTruncated no bloquea éxito", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), {
          stderrTruncated: true,
          stderr: "warning",
        }),
      );

      expect(result.supervisorResult.classification).toBe("EXECUTABLE_TASK");
    });

    it("error expone hasStderr", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("", { stderr: "warning" })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.hasStderr).toBe(true);
    });

    it("error expone stderrTruncated", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("", { stderr: "warning", stderrTruncated: true })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.stderrTruncated).toBe(true);
    });

    it("error expone preview máximo 400", () => {
      const stderr = "x".repeat(900);
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("", { stderr })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.stderrPreview).toHaveLength(400);
      expect(error.stderrPreview).toBe(stderr.slice(0, 400));
    });

    it("error omite preview cuando stderr está vacío", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("")),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.stderrPreview).toBeUndefined();
    });

    it("mensaje no incluye stderr completo", () => {
      const stderr = "secret stderr content";
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("", { stderr })),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.message).not.toContain(stderr);
    });
  });

  describe("errores", () => {
    it("error extiende Error", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("")),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error).toBeInstanceOf(Error);
    });

    it("name correcto", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("")),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.name).toBe("SupervisorOpenCodeInterpretationError");
    });

    it("código correcto", () => {
      const codes: SupervisorOpenCodeInterpretationErrorCode[] = [
        "PROCESS_EXIT_NOT_ZERO",
        "PROCESS_EXIT_UNKNOWN",
        "PROCESS_SIGNALED",
        "OUTPUT_PARSE_FAILED",
        "OUTPUT_NOT_FINISHED",
        "PROTOCOL_PARSE_FAILED",
        "ROLE_MISMATCH",
        "AGENT_STATUS_NOT_ACCEPTED",
        "SUPERVISOR_PAYLOAD_INVALID",
        "SUPERVISOR_PAYLOAD_SEMANTIC_ERROR",
      ];

      expect(codes).toHaveLength(10);
    });

    it("cause preservado para output", () => {
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult("")),
        "OUTPUT_PARSE_FAILED",
      );

      expect(error.cause).toBeInstanceOf(OpenCodeOutputParseError);
    });

    it("cause preservado para protocolo", () => {
      const stdout = `${textEventJSONL("not valid json")}\n${stepFinishJSONL()}`;
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "PROTOCOL_PARSE_FAILED",
      );

      expect(error.cause).toBeInstanceOf(AgentProtocolParseError);
    });

    it("cause preservado para payload estructural", () => {
      const stdout = validStdout(supervisorEnvelope({ payload: { bad: true } }));
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "SUPERVISOR_PAYLOAD_INVALID",
      );

      expect(error.cause).toBeInstanceOf(SupervisorPayloadValidationError);
    });

    it("cause preservado para payload semántico", () => {
      const stdout = validStdout(
        supervisorEnvelope({
          payload: {
            ...executableTaskPayload(),
            allowedPaths: ["/etc/passwd"],
          },
        }),
      );
      const error = expectInterpretationError(
        () => interpretSupervisorOpenCodeResult(makeProcessResult(stdout)),
        "SUPERVISOR_PAYLOAD_SEMANTIC_ERROR",
      );

      expect(error.cause).toBeInstanceOf(SupervisorPayloadSemanticError);
    });

    it("errores inesperados dentro de parseOpenCodeOutput preservan la cadena de cause", () => {
      const result = makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })));
      const originalParse = JSON.parse;

      try {
        JSON.parse = ((text: string) => {
          if (text.includes("protocolVersion")) {
            throw new RangeError("unexpected parser failure");
          }
          return originalParse(text);
        }) as typeof JSON.parse;

        const error = expectInterpretationError(
          () => interpretSupervisorOpenCodeResult(result),
          "OUTPUT_PARSE_FAILED",
        );

        expect(error.cause).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error.cause as OpenCodeOutputParseError).cause).toBeInstanceOf(RangeError);
      } finally {
        JSON.parse = originalParse;
      }
    });
  });

  describe("inmutabilidad", () => {
    it("OpenCodeProcessResult no se muta", () => {
      const result = makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() })), {
        stderr: "warning",
        stderrTruncated: true,
      });
      const snapshot = JSON.parse(JSON.stringify(result));

      interpretSupervisorOpenCodeResult(result);

      expect(result).toEqual(snapshot);
    });

    it("resultado devuelto tiene shape mínimo exacto", () => {
      const result = interpretSupervisorOpenCodeResult(
        makeProcessResult(validStdout(supervisorEnvelope({ payload: executableTaskPayload() }))),
      );

      expect(Object.keys(result).sort()).toEqual([
        "messageID",
        "sessionID",
        "supervisorResult",
      ]);
    });
  });
});
