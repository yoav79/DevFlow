import { describe, expect, it } from "vitest";

import {
  parseOpenCodeOutput,
  OpenCodeOutputParseError,
  type OpenCodeOutputParseInput,
} from "../../src/services/opencode-output-parser.js";
import type { ReviewerExecutionResult } from "../../src/services/reviewer-opencode-executor.js";
import {
  interpretReviewerOpenCodeResult,
  ReviewerOpenCodeInterpretationError,
} from "../../src/services/reviewer-opencode-integration.js";
import { ReviewerResultValidationError } from "../../src/services/reviewer-result-parser.js";
import type { ReviewerResult } from "../../src/schemas/reviewer-result-schema.js";

function makeResult(
  overrides: Partial<ReviewerExecutionResult> & { stdout: string },
): ReviewerExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    stderr: "",
    durationMs: 500,
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

const VALID_APPROVED: ReviewerResult = {
  verdict: "APPROVED",
  summary: "Cumple con el contrato.",
  findings: [],
  requiredChanges: [],
};

const VALID_REVISION: ReviewerResult = {
  verdict: "REVISION_REQUIRED",
  summary: "Requiere cambios.",
  findings: [
    {
      code: "F-001",
      severity: "MEDIUM",
      title: "Error detectado",
      description: "Descripción.",
    },
  ],
  requiredChanges: [
    {
      code: "RC-001",
      description: "Corregir error.",
      acceptanceCriteria: ["Criterio A"],
      relatedFindingCodes: ["F-001"],
    },
  ],
};

function approvedJSONL(): string {
  return JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "s", part: { id: "a", messageID: "m", sessionID: "s", type: "step-start" } }) + "\n"
    + JSON.stringify({ type: "text", timestamp: 2, sessionID: "s", part: { id: "b", messageID: "m", sessionID: "s", type: "text", text: JSON.stringify(VALID_APPROVED) } }) + "\n"
    + JSON.stringify({ type: "step_finish", timestamp: 3, sessionID: "s", part: { id: "c", messageID: "m", sessionID: "s", type: "step-finish", reason: "stop" } });
}

function revisionJSONL(): string {
  return JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "s", part: { id: "a", messageID: "m", sessionID: "s", type: "step-start" } }) + "\n"
    + JSON.stringify({ type: "text", timestamp: 2, sessionID: "s", part: { id: "b", messageID: "m", sessionID: "s", type: "text", text: JSON.stringify(VALID_REVISION) } }) + "\n"
    + JSON.stringify({ type: "step_finish", timestamp: 3, sessionID: "s", part: { id: "c", messageID: "m", sessionID: "s", type: "step-finish", reason: "stop" } });
}

describe("interpretReviewerOpenCodeResult", () => {
  describe("happy path", () => {
    it("returns APPROMOVED ReviewerResult", () => {
      const result = interpretReviewerOpenCodeResult(makeResult({ stdout: approvedJSONL() }));
      expect(result).toEqual(VALID_APPROVED);
    });

    it("returns REVISION_REQUIRED ReviewerResult", () => {
      const result = interpretReviewerOpenCodeResult(makeResult({ stdout: revisionJSONL() }));
      expect(result).toEqual(VALID_REVISION);
    });

    it("tolerates stderr when exitCode is 0", () => {
      const result = interpretReviewerOpenCodeResult(
        makeResult({ stdout: approvedJSONL(), stderr: "warning: deprecado\n" }),
      );
      expect(result).toEqual(VALID_APPROVED);
    });
  });

  describe("process validation", () => {
    it("rejects signal: PROCESS_SIGNALED", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "", signal: "SIGTERM", exitCode: null }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("PROCESS_SIGNALED");
        expect((error as ReviewerOpenCodeInterpretationError).signal).toBe("SIGTERM");
        expect((error as ReviewerOpenCodeInterpretationError).exitCode).toBeNull();
      }
    });

    it("rejects exitCode null: PROCESS_EXIT_UNKNOWN", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "", exitCode: null }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("PROCESS_EXIT_UNKNOWN");
        expect((error as ReviewerOpenCodeInterpretationError).exitCode).toBeNull();
      }
    });

    it("rejects exitCode non-zero: PROCESS_EXIT_NOT_ZERO", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "", exitCode: 1 }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("PROCESS_EXIT_NOT_ZERO");
        expect((error as ReviewerOpenCodeInterpretationError).exitCode).toBe(1);
      }
    });
  });

  describe("output parse failures (wrapped as OUTPUT_PARSE_FAILED)", () => {
    it("rejects timedOut via parseOpenCodeOutput", () => {
      try {
        interpretReviewerOpenCodeResult(
          makeResult({ stdout: approvedJSONL(), timedOut: true }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(OpenCodeOutputParseError);
        expect(((error as ReviewerOpenCodeInterpretationError).cause as OpenCodeOutputParseError).code).toBe("TIMED_OUT_PROCESS");
      }
    });

    it("rejects aborted via parseOpenCodeOutput", () => {
      try {
        interpretReviewerOpenCodeResult(
          makeResult({ stdout: approvedJSONL(), aborted: true }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(OpenCodeOutputParseError);
        expect(((error as ReviewerOpenCodeInterpretationError).cause as OpenCodeOutputParseError).code).toBe("ABORTED_PROCESS");
      }
    });

    it("rejects empty stdout", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "" }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(OpenCodeOutputParseError);
        expect(((error as ReviewerOpenCodeInterpretationError).cause as OpenCodeOutputParseError).code).toBe("EMPTY_OUTPUT");
      }
    });

    it("rejects whitespace-only stdout", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "   \n  \n  " }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
      }
    });

    it("rejects invalid JSONL", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "not-json\n" }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(OpenCodeOutputParseError);
        expect(((error as ReviewerOpenCodeInterpretationError).cause as OpenCodeOutputParseError).code).toBe("INVALID_JSON_LINE");
      }
    });

    it("rejects missing assistant output", () => {
      const noText =
        JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "s", part: { id: "a", messageID: "m", sessionID: "s", type: "step-start" } }) + "\n"
        + JSON.stringify({ type: "step_finish", timestamp: 3, sessionID: "s", part: { id: "c", messageID: "m", sessionID: "s", type: "step-finish", reason: "stop" } });
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: noText }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(OpenCodeOutputParseError);
        expect(((error as ReviewerOpenCodeInterpretationError).cause as OpenCodeOutputParseError).code).toBe("MISSING_ASSISTANT_OUTPUT");
      }
    });
  });

  describe("output not finished", () => {
    it("rejects unfinished output: OUTPUT_NOT_FINISHED", () => {
      const noFinish =
        JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "s", part: { id: "a", messageID: "m", sessionID: "s", type: "step-start" } }) + "\n"
        + JSON.stringify({ type: "text", timestamp: 2, sessionID: "s", part: { id: "b", messageID: "m", sessionID: "s", type: "text", text: JSON.stringify(VALID_APPROVED) } });
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: noFinish }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_NOT_FINISHED");
      }
    });
  });

  describe("reviewer result validation", () => {
    it("rejects non-JSON assistantText: REVIEWER_RESULT_INVALID", () => {
      const stepStart = '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"a","messageID":"m","sessionID":"s","type":"step-start"}}';
      const text = '{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"b","messageID":"m","sessionID":"s","type":"text","text":"not a json object"}}';
      const stepFinish = '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"c","messageID":"m","sessionID":"s","type":"step-finish","reason":"stop"}}';
      const badJSON = [stepStart, text, stepFinish].join("\n");
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: badJSON }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("REVIEWER_RESULT_INVALID");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(SyntaxError);
      }
    });

    it("rejects structurally invalid ReviewerResult", () => {
      const stepStart = '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"a","messageID":"m","sessionID":"s","type":"step-start"}}';
      const text = '{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"b","messageID":"m","sessionID":"s","type":"text","text":"{\\"foo\\":\\"bar\\"}"}}';
      const stepFinish = '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"c","messageID":"m","sessionID":"s","type":"step-finish","reason":"stop"}}';
      const bad = [stepStart, text, stepFinish].join("\n");
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: bad }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("REVIEWER_RESULT_INVALID");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(ReviewerResultValidationError);
      }
    });

    it("rejects semantically invalid APPROVED with MEDIUM finding", () => {
      const stepStart = '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"a","messageID":"m","sessionID":"s","type":"step-start"}}';
      const badApproved = '{"verdict":"APPROVED","summary":"Sí.","findings":[{"code":"F-002","severity":"MEDIUM","title":"Problema","description":"Desc."}],"requiredChanges":[]}';
      const textEvent = JSON.parse('{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"b","messageID":"m","sessionID":"s","type":"text","text":""}}');
      textEvent.part.text = badApproved;
      const text = JSON.stringify(textEvent);
      const stepFinish = '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"c","messageID":"m","sessionID":"s","type":"step-finish","reason":"stop"}}';
      const stdout = [stepStart, text, stepFinish].join("\n");
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("REVIEWER_RESULT_INVALID");
        expect((error as ReviewerOpenCodeInterpretationError).cause).toBeInstanceOf(ReviewerResultValidationError);
      }
    });
  });

  describe("immutability", () => {
    it("does not mutate input", () => {
      const result = makeResult({ stdout: approvedJSONL() });
      const copy = { ...result, stdout: result.stdout.slice() };
      interpretReviewerOpenCodeResult(result);
      expect(result).toEqual(copy);
    });
  });

  describe("error metadata", () => {
    it("includes exitCode, signal, timedOut, aborted, durationMs, hasStderr", () => {
      try {
        interpretReviewerOpenCodeResult(
          makeResult({ stdout: "", exitCode: 1, durationMs: 999 }),
        );
      } catch (error) {
        const e = error as ReviewerOpenCodeInterpretationError;
        expect(e.exitCode).toBe(1);
        expect(e.signal).toBeNull();
        expect(e.timedOut).toBe(false);
        expect(e.aborted).toBe(false);
        expect(e.durationMs).toBe(999);
        expect(e.hasStderr).toBe(false);
      }
    });

    it("does not include stdout or stderr", () => {
      try {
        interpretReviewerOpenCodeResult(
          makeResult({ stdout: "", exitCode: 1 }),
        );
      } catch (error) {
        const e = error as Record<string, unknown>;
        expect(e).not.toHaveProperty("stdout");
        expect(e).not.toHaveProperty("stderr");
      }
    });
  });

  describe("unexpected errors propagate by identity", () => {
    it("OUTPUT_PARSE_FAILED wraps OpenCodeOutputParseError, no silent catch", () => {
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout: "" }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("OUTPUT_PARSE_FAILED");
      }
    });

    it("REVIEWER_RESULT_INVALID wraps ReviewerResultValidationError, no silent catch", () => {
      const stepStart = '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"a","messageID":"m","sessionID":"s","type":"step-start"}}';
      const text = '{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"b","messageID":"m","sessionID":"s","type":"text","text":"{\\"bad\\":\\"json\\"}"}}';
      const stepFinish = '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"c","messageID":"m","sessionID":"s","type":"step-finish","reason":"stop"}}';
      const stdout = [stepStart, text, stepFinish].join("\n");
      try {
        interpretReviewerOpenCodeResult(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerOpenCodeInterpretationError);
        expect((error as ReviewerOpenCodeInterpretationError).code).toBe("REVIEWER_RESULT_INVALID");
      }
    });
  });

  describe("boundary enforcement", () => {
    it("does not execute OpenCode", () => {
      const result = interpretReviewerOpenCodeResult(makeResult({ stdout: approvedJSONL() }));
      expect(result).toEqual(VALID_APPROVED);
    });

    it("does not access DB", () => {
      const result = interpretReviewerOpenCodeResult(makeResult({ stdout: approvedJSONL() }));
      expect(result).toEqual(VALID_APPROVED);
    });

    it("does not change any state", () => {
      const input = makeResult({ stdout: approvedJSONL() });
      const copy = { ...input, stdout: input.stdout.slice() };
      interpretReviewerOpenCodeResult(input);
      expect(input).toEqual(copy);
    });

    it("does not retry", () => {
      const result = interpretReviewerOpenCodeResult(makeResult({ stdout: approvedJSONL() }));
      expect(result).toEqual(VALID_APPROVED);
    });
  });
});
