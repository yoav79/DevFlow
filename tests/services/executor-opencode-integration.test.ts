import { describe, expect, it } from "vitest";

import type { AgentEnvelope } from "../../src/services/agent-protocol.js";
import { AgentProtocolParseError } from "../../src/services/agent-protocol.js";
import type { OpenCodeProcessResult } from "../../src/services/opencode-process-runner.js";
import { OpenCodeOutputParseError } from "../../src/services/opencode-output-parser.js";
import {
  interpretExecutorOpenCodeResult,
  ExecutorOpenCodeInterpretationError,
  type ExecutorOpenCodeInterpretationErrorCode,
} from "../../src/services/executor-opencode-integration.js";
import {
  ExecutorPayloadSemanticError,
  ExecutorPayloadValidationError,
} from "../../src/services/executor-agent-payload.js";

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

function executorEnvelope(overrides: Partial<AgentEnvelope> = {}): AgentEnvelope {
  return {
    protocolVersion: 1,
    role: "executor",
    status: "COMPLETED",
    summary: "Tarea completada.",
    questions: [],
    risks: [],
    payload: { filesClaimed: [], commandsClaimed: [] },
    ...overrides,
  };
}

function executorPayload() {
  return {
    filesClaimed: ["src/app.ts"],
    commandsClaimed: ["npm test"],
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
  code: ExecutorOpenCodeInterpretationErrorCode,
): ExecutorOpenCodeInterpretationError {
  try {
    fn();
    expect.fail("Should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutorOpenCodeInterpretationError);
    const typed = error as ExecutorOpenCodeInterpretationError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

describe("interpretExecutorOpenCodeResult", () => {
  describe("happy path", () => {
    it("COMPLETED produces valid interpretation", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() }))),
      );

      expect(result.executorPayload).toEqual(executorPayload());
      expect(result.envelope.status).toBe("COMPLETED");
      expect(result.envelope.summary).toBe("Tarea completada.");
    });

    it("NEEDS_INPUT produces valid interpretation", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "NEEDS_INPUT",
          questions: ["¿Qué framework se usa?"],
          payload: executorPayload(),
        }))),
      );

      expect(result.executorPayload).toEqual(executorPayload());
      expect(result.envelope.status).toBe("NEEDS_INPUT");
    });

    it("BLOCKED produces valid interpretation", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "BLOCKED",
          summary: "Bloqueado por falta de permisos.",
          payload: executorPayload(),
        }))),
      );

      expect(result.executorPayload).toEqual(executorPayload());
      expect(result.envelope.status).toBe("BLOCKED");
    });

    it("FAILED produces valid interpretation", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "FAILED",
          summary: "No se pudo completar.",
          payload: executorPayload(),
        }))),
      );

      expect(result.executorPayload).toEqual(executorPayload());
      expect(result.envelope.status).toBe("FAILED");
    });

    it("sessionID present is preserved", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() }), "msg-22", "sess-99")),
      );

      expect(result.sessionID).toBe("sess-99");
    });

    it("messageID is preserved", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() }), "msg-22", "sess-99")),
      );

      expect(result.messageID).toBe("msg-22");
    });

    it("envelope is returned with status, summary, questions, risks", () => {
      const envelope = executorEnvelope({
        status: "COMPLETED",
        summary: "Hecho.",
        questions: ["¿Confirmas?"],
        risks: ["Baja confianza"],
        payload: executorPayload(),
      });
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(envelope)),
      );

      expect(result.envelope.status).toBe("COMPLETED");
      expect(result.envelope.summary).toBe("Hecho.");
      expect(result.envelope.questions).toEqual(["¿Confirmas?"]);
      expect(result.envelope.risks).toEqual(["Baja confianza"]);
    });

    it("executorPayload is returned with filesClaimed, commandsClaimed", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() }))),
      );

      expect(result.executorPayload.filesClaimed).toEqual(["src/app.ts"]);
      expect(result.executorPayload.commandsClaimed).toEqual(["npm test"]);
    });

    it("empty arrays valid for any status", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "COMPLETED",
          payload: { filesClaimed: [], commandsClaimed: [] },
        }))),
      );

      expect(result.executorPayload.filesClaimed).toEqual([]);
      expect(result.executorPayload.commandsClaimed).toEqual([]);
    });

    it("COMPLETED can include questions", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "COMPLETED",
          questions: ["¿Deseas continuar?"],
          payload: executorPayload(),
        }))),
      );

      expect(result.envelope.questions).toEqual(["¿Deseas continuar?"]);
      expect(result.envelope.status).toBe("COMPLETED");
    });

    it("NEEDS_INPUT can have empty questions", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "NEEDS_INPUT",
          questions: [],
          payload: executorPayload(),
        }))),
      );

      expect(result.envelope.questions).toEqual([]);
      expect(result.envelope.status).toBe("NEEDS_INPUT");
    });

    it("BLOCKED can have empty risks", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "BLOCKED",
          risks: [],
          payload: executorPayload(),
        }))),
      );

      expect(result.envelope.risks).toEqual([]);
      expect(result.envelope.status).toBe("BLOCKED");
    });

    it("FAILED uses same minimal payload", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({
          status: "FAILED",
          payload: { filesClaimed: [], commandsClaimed: [] },
        }))),
      );

      expect(result.executorPayload.filesClaimed).toEqual([]);
      expect(result.executorPayload.commandsClaimed).toEqual([]);
    });

    it("no duplicate fields from envelope in return", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() }))),
      ) as unknown as Record<string, unknown>;

      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("summary");
      expect(result).not.toHaveProperty("questions");
      expect(result).not.toHaveProperty("risks");
      expect(result).not.toHaveProperty("filesClaimed");
      expect(result).not.toHaveProperty("commandsClaimed");
      expect(result).not.toHaveProperty("parsedOutput");
      expect(result).not.toHaveProperty("assistantText");
      expect(result).not.toHaveProperty("rawStdout");
      expect(result).not.toHaveProperty("stderr");
    });

    it("resultado devuelto tiene shape mínimo exacto", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() }))),
      );

      expect(Object.keys(result).sort()).toEqual([
        "envelope",
        "executorPayload",
        "messageID",
        "sessionID",
      ]);
    });
  });

  describe("process guards", () => {
    it("signal no nula -> PROCESS_SIGNALED", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { signal: "SIGTERM" })),
        "PROCESS_SIGNALED",
      );

      expect(error.signal).toBe("SIGTERM");
    });

    it("exitCode null -> PROCESS_EXIT_UNKNOWN", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { exitCode: null })),
        "PROCESS_EXIT_UNKNOWN",
      );

      expect(error.exitCode).toBeNull();
    });

    it("exitCode no cero -> PROCESS_EXIT_NOT_ZERO", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { exitCode: 2 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.exitCode).toBe(2);
    });

    it("stderr no vacío no bloquea éxito", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), {
          stderr: "warning: rate limited",
        }),
      );

      expect(result.executorPayload).toEqual(executorPayload());
    });

    it("stderrTruncated no bloquea éxito", () => {
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), {
          stderrTruncated: true,
          stderr: "warning",
        }),
      );

      expect(result.executorPayload).toEqual(executorPayload());
    });

    it("error expone hasStderr", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { stderr: "warning", exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.hasStderr).toBe(true);
    });

    it("error expone stderrTruncated", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { stderrTruncated: true, stderr: "warning", exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.stderrTruncated).toBe(true);
    });

    it("error expone preview máximo 400", () => {
      const stderr = "x".repeat(900);
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { stderr, exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.stderrPreview).toHaveLength(400);
      expect(error.stderrPreview).toBe(stderr.slice(0, 400));
    });

    it("error omite preview cuando stderr está vacío", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.stderrPreview).toBeUndefined();
    });

    it("mensaje no incluye stderr completo", () => {
      const stderr = "secret stderr content";
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { stderr, exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.message).not.toContain(stderr);
    });
  });

  describe("precedence", () => {
    it("timedOut + signal produce TIMED_OUT_PROCESS, no PROCESS_SIGNALED", () => {
      try {
        interpretExecutorOpenCodeResult(
          makeProcessResult("anything", { timedOut: true, signal: "SIGTERM", exitCode: null }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("TIMED_OUT_PROCESS");
      }
    });

    it("aborted + signal produce ABORTED_PROCESS, no PROCESS_SIGNALED", () => {
      try {
        interpretExecutorOpenCodeResult(
          makeProcessResult("anything", { aborted: true, signal: "SIGTERM", exitCode: null }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("ABORTED_PROCESS");
      }
    });

    it("stdoutTruncated + exitCode non-zero produce TRUNCATED_OUTPUT, no PROCESS_EXIT_NOT_ZERO", () => {
      try {
        interpretExecutorOpenCodeResult(
          makeProcessResult("anything", { stdoutTruncated: true, exitCode: 17 }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("TRUNCATED_OUTPUT");
      }
    });

    it("signal tiene precedencia sobre exitCode null", () => {
      expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { signal: "SIGTERM", exitCode: null })),
        "PROCESS_SIGNALED",
      );
    });

    it("exitCode null tiene precedencia sobre exitCode non-zero", () => {
      expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { exitCode: null })),
        "PROCESS_EXIT_UNKNOWN",
      );
    });
  });

  describe("output propagated errors", () => {
    it("stdout vacío produce OpenCodeOutputParseError con EMPTY_OUTPUT", () => {
      try {
        interpretExecutorOpenCodeResult(makeProcessResult(""));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("EMPTY_OUTPUT");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("JSONL inválido produce INVALID_JSON_LINE", () => {
      try {
        interpretExecutorOpenCodeResult(makeProcessResult("NOT JSON"));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_JSON_LINE");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("evento inválido produce INVALID_EVENT_SHAPE", () => {
      const bad = JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_x", part: null });
      const stdout = `${bad}\n${stepFinishJSONL()}`;

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("ausencia de assistant text produce MISSING_ASSISTANT_OUTPUT", () => {
      const stdout = stepFinishJSONL();

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("MISSING_ASSISTANT_OUTPUT");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("stdoutTruncated produce TRUNCATED_OUTPUT", () => {
      try {
        interpretExecutorOpenCodeResult(makeProcessResult("anything", { stdoutTruncated: true }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("TRUNCATED_OUTPUT");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("timedOut produce TIMED_OUT_PROCESS", () => {
      try {
        interpretExecutorOpenCodeResult(makeProcessResult("anything", { timedOut: true }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("TIMED_OUT_PROCESS");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("aborted produce ABORTED_PROCESS", () => {
      try {
        interpretExecutorOpenCodeResult(makeProcessResult("anything", { aborted: true }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("ABORTED_PROCESS");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("finished false produce OUTPUT_NOT_FINISHED", () => {
      const stdout = envelopeJSONL(executorEnvelope({ payload: executorPayload() }));

      expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(stdout)),
        "OUTPUT_NOT_FINISHED",
      );
    });
  });

  describe("protocol propagated errors", () => {
    it("assistantText no JSON produce AgentProtocolParseError con INVALID_JSON", () => {
      const stdout = `${textEventJSONL("not valid json")}\n${stepFinishJSONL()}`;

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentProtocolParseError);
        expect((error as AgentProtocolParseError).code).toBe("INVALID_JSON");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("envelope inválido produce INVALID_ENVELOPE", () => {
      const invalidEnvelope = {
        protocolVersion: 1,
        role: "executor",
        status: "COMPLETED",
        summary: "ok",
        questions: [],
        risks: [],
      };
      const stdout = `${textEventJSONL(JSON.stringify(invalidEnvelope))}\n${stepFinishJSONL()}`;

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentProtocolParseError);
        expect((error as AgentProtocolParseError).code).toBe("INVALID_ENVELOPE");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("protocolVersion inválida produce UNSUPPORTED_PROTOCOL_VERSION", () => {
      const badEnvelope = {
        protocolVersion: 2,
        role: "executor",
        status: "COMPLETED",
        summary: "ok",
        questions: [],
        risks: [],
        payload: { filesClaimed: [], commandsClaimed: [] },
      };
      const stdout = `${textEventJSONL(JSON.stringify(badEnvelope))}\n${stepFinishJSONL()}`;

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentProtocolParseError);
        expect((error as AgentProtocolParseError).code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("role distinto de executor produce ROLE_MISMATCH", () => {
      const stdout = validStdout(
        executorEnvelope({ role: "supervisor", payload: executorPayload() }),
      );

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentProtocolParseError);
        expect((error as AgentProtocolParseError).code).toBe("ROLE_MISMATCH");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });
  });

  describe("payload propagated errors", () => {
    it("payload estructuralmente inválido produce ExecutorPayloadValidationError", () => {
      const stdout = validStdout(
        executorEnvelope({ payload: { filesClaimed: [], commandsClaimed: [""] } }),
      );

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ExecutorPayloadValidationError);
        const typed = error as ExecutorPayloadValidationError;
        expect(typed.name).toBe("ExecutorPayloadValidationError");
        expect(typed.issues.length).toBeGreaterThan(0);
        expect(typeof typed.issues[0]!.code).toBe("string");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });

    it("payload con duplicados produce ExecutorPayloadSemanticError", () => {
      const stdout = validStdout(
        executorEnvelope({
          payload: {
            filesClaimed: ["src/a.ts", "src/a.ts"],
            commandsClaimed: [],
          },
        }),
      );

      try {
        interpretExecutorOpenCodeResult(makeProcessResult(stdout));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ExecutorPayloadSemanticError);
        const typed = error as ExecutorPayloadSemanticError;
        expect(typed.name).toBe("ExecutorPayloadSemanticError");
        expect(typed.issues.length).toBeGreaterThan(0);
        expect(typed.issues[0]!.code).toBe("DUPLICATE_VALUE");
        expect(error).not.toBeInstanceOf(ExecutorOpenCodeInterpretationError);
      }
    });
  });

  describe("error class", () => {
    it("error extiende Error", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error).toBeInstanceOf(Error);
    });

    it("name correcto", () => {
      const error = expectInterpretationError(
        () => interpretExecutorOpenCodeResult(makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), { exitCode: 1 })),
        "PROCESS_EXIT_NOT_ZERO",
      );

      expect(error.name).toBe("ExecutorOpenCodeInterpretationError");
    });

    it("todos los códigos son los autorizados", () => {
      const codes: ExecutorOpenCodeInterpretationErrorCode[] = [
        "PROCESS_EXIT_NOT_ZERO",
        "PROCESS_EXIT_UNKNOWN",
        "PROCESS_SIGNALED",
        "OUTPUT_NOT_FINISHED",
      ];

      expect(codes).toHaveLength(4);
    });
  });

  describe("inmutabilidad", () => {
    it("OpenCodeProcessResult no se muta", () => {
      const result = makeProcessResult(validStdout(executorEnvelope({ payload: executorPayload() })), {
        stderr: "warning",
        stderrTruncated: true,
      });
      const snapshot = JSON.parse(JSON.stringify(result));

      interpretExecutorOpenCodeResult(result);

      expect(result).toEqual(snapshot);
    });

    it("envelope materializado no se muta", () => {
      const envelope = executorEnvelope({
        status: "COMPLETED",
        questions: ["q1"],
        risks: ["r1"],
        payload: executorPayload(),
      });
      const stdout = validStdout(envelope);
      const result = makeProcessResult(stdout);
      const envelopeSnapshot = JSON.parse(JSON.stringify(envelope));

      interpretExecutorOpenCodeResult(result);

      expect(envelope).toEqual(envelopeSnapshot);
    });

    it("executorPayload arrays no se mutan", () => {
      const payload = executorPayload();
      const envelope = executorEnvelope({ payload });
      const stdout = validStdout(envelope);
      const result = makeProcessResult(stdout);
      const payloadSnapshot = JSON.parse(JSON.stringify(payload));

      interpretExecutorOpenCodeResult(result);

      expect(payload).toEqual(payloadSnapshot);
    });

    it("preserva orden y strings exactos de filesClaimed", () => {
      const payload = {
        filesClaimed: ["src/b.ts", " src/a.ts ", "src/c.ts"],
        commandsClaimed: ["npm test"],
      };
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload }))),
      );

      expect(result.executorPayload.filesClaimed).toEqual(["src/b.ts", " src/a.ts ", "src/c.ts"]);
    });

    it("preserva orden y strings exactos de commandsClaimed", () => {
      const payload = {
        filesClaimed: ["src/a.ts"],
        commandsClaimed: ["npm run lint", " npm test "],
      };
      const result = interpretExecutorOpenCodeResult(
        makeProcessResult(validStdout(executorEnvelope({ payload }))),
      );

      expect(result.executorPayload.commandsClaimed).toEqual(["npm run lint", " npm test "]);
    });
  });
});
