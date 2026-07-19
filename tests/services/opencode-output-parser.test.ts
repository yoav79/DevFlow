/// <reference types="node" />

import { describe, it, expect } from "vitest";
import {
  parseOpenCodeOutput,
  OpenCodeOutputParseError,
  type OpenCodeProcessResult,
} from "../../src/services/opencode-output-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  overrides: Partial<OpenCodeProcessResult> & { stdout: string },
): OpenCodeProcessResult {
  return {
    binaryPath: "opencode",
    args: [],
    cwd: "/tmp",
    exitCode: 0,
    signal: null,
    stderr: "",
    durationMs: 100,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function event(step: string): string {
  return JSON.stringify(step);
}

const STEP_START = JSON.stringify({
  type: "step_start",
  timestamp: 1784417901774,
  sessionID: "ses_x",
  part: { id: "prt_a", messageID: "msg_m", sessionID: "ses_x", type: "step-start" },
});

const TEXT_READY = JSON.stringify({
  type: "text",
  timestamp: 1784417901774,
  sessionID: "ses_x",
  part: { id: "prt_b", messageID: "msg_m", sessionID: "ses_x", type: "text", text: "READY" },
});

const STEP_FINISH = JSON.stringify({
  type: "step_finish",
  timestamp: 1784417901774,
  sessionID: "ses_x",
  part: { id: "prt_c", messageID: "msg_m", sessionID: "ses_x", type: "step-finish", reason: "stop" },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseOpenCodeOutput", () => {
  describe("basic parsing", () => {
    it("parses step_start/text/step_finish sequence", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.events).toHaveLength(3);
      expect(result.events[0]!.type).toBe("step_start");
      expect(result.events[1]!.type).toBe("text");
      expect(result.events[2]!.type).toBe("step_finish");
      expect(result.assistantText).toBe("READY");
    });

    it("preserves rawStdout", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.rawStdout).toBe(stdout);
    });

    it("preserves stderr", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout, stderr: "diagnostic info" }));

      expect(result.stderr).toBe("diagnostic info");
    });

    it("extracts sessionID from text events", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.sessionID).toBe("ses_x");
    });

    it("extracts messageID from text events", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.messageID).toBe("msg_m");
    });

    it("sets finished true with step_finish of same messageID", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.finished).toBe(true);
    });
  });

  describe("text concatenation", () => {
    it("concatenates multiple text events from same messageID in order", () => {
      const text1 = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: { id: "t1", messageID: "msg_m", sessionID: "ses_x", type: "text", text: "Hello " },
      });
      const text2 = JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_x",
        part: { id: "t2", messageID: "msg_m", sessionID: "ses_x", type: "text", text: "World" },
      });

      const stdout = [STEP_START, text1, text2, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.assistantText).toBe("Hello World");
    });

    it("selects the last non-empty messageID group", () => {
      const textEarlier = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: { id: "t1", messageID: "msg_earlier", sessionID: "ses_x", type: "text", text: "old" },
      });
      const textLater = JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_x",
        part: { id: "t2", messageID: "msg_later", sessionID: "ses_x", type: "text", text: "new response" },
      });

      const stdout = [textEarlier, textLater].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.messageID).toBe("msg_later");
      expect(result.assistantText).toBe("new response");
    });

    it("skips empty text when selecting final message", () => {
      const textEmpty = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: { id: "t1", messageID: "msg_empty", sessionID: "ses_x", type: "text", text: "" },
      });
      const textReal = JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_x",
        part: { id: "t2", messageID: "msg_real", sessionID: "ses_x", type: "text", text: "actual content" },
      });

      const stdout = [textEmpty, textReal].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.messageID).toBe("msg_real");
      expect(result.assistantText).toBe("actual content");
    });

    it("skips whitespace-only text when selecting final message", () => {
      const textWs = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: { id: "t1", messageID: "msg_ws", sessionID: "ses_x", type: "text", text: "   \n  " },
      });
      const textReal = JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_x",
        part: { id: "t2", messageID: "msg_real", sessionID: "ses_x", type: "text", text: "content" },
      });

      const stdout = [textWs, textReal].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.messageID).toBe("msg_real");
    });
  });

  describe("step_finish correlation", () => {
    it("step_finish of another messageID does not mark finished", () => {
      const text1 = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: { id: "t1", messageID: "msg_a", sessionID: "ses_x", type: "text", text: "response" },
      });
      const finishB = JSON.stringify({
        type: "step_finish",
        timestamp: 2,
        sessionID: "ses_x",
        part: { id: "f1", messageID: "msg_b", sessionID: "ses_x", type: "step-finish", reason: "stop" },
      });

      const stdout = [text1, finishB].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.messageID).toBe("msg_a");
      expect(result.finished).toBe(false);
    });
  });

  describe("whitespace and line handling", () => {
    it("ignores empty lines between events", () => {
      const stdout = [STEP_START, "", TEXT_READY, "", STEP_FINISH, ""].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.events).toHaveLength(3);
      expect(result.assistantText).toBe("READY");
    });

    it("supports CRLF line endings", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\r\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.events).toHaveLength(3);
      expect(result.assistantText).toBe("READY");
    });
  });

  describe("unknown events", () => {
    it("preserves unknown events", () => {
      const unknown = JSON.stringify({ type: "future_event", timestamp: 1, sessionID: "ses_x", data: 42 });
      const stdout = [STEP_START, unknown, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.events).toHaveLength(4);
      expect(result.events[1]!.type).toBe("future_event");
    });

    it("unknown events do not break text extraction", () => {
      const unknown = JSON.stringify({ type: "some_event", timestamp: 1 });
      const stdout = [unknown, TEXT_READY].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.assistantText).toBe("READY");
    });

    it("rejects events without valid type string", () => {
      const bad = JSON.stringify({ type: 123, timestamp: 1 });
      const stdout = [STEP_START, bad, TEXT_READY].join("\n");

      expect(() => parseOpenCodeOutput(makeResult({ stdout }))).toThrow(OpenCodeOutputParseError);
    });
  });

  describe("error conditions", () => {
    it("empty stdout produces EMPTY_OUTPUT", () => {
      expect(() => parseOpenCodeOutput(makeResult({ stdout: "" }))).toThrow(OpenCodeOutputParseError);

      try {
        parseOpenCodeOutput(makeResult({ stdout: "" }));
      } catch (error) {
        expect((error as OpenCodeOutputParseError).code).toBe("EMPTY_OUTPUT");
      }
    });

    it("whitespace-only stdout produces EMPTY_OUTPUT", () => {
      expect(() => parseOpenCodeOutput(makeResult({ stdout: "   \n  \n  " }))).toThrow(OpenCodeOutputParseError);

      try {
        parseOpenCodeOutput(makeResult({ stdout: "   \n  \n  " }));
      } catch (error) {
        expect((error as OpenCodeOutputParseError).code).toBe("EMPTY_OUTPUT");
      }
    });

    it("invalid JSON produces INVALID_JSON_LINE with lineNumber", () => {
      const stdout = [STEP_START, "NOT JSON", TEXT_READY].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_JSON_LINE");
        expect((error as OpenCodeOutputParseError).lineNumber).toBe(2);
      }
    });

    it("step_start with invalid shape produces INVALID_EVENT_SHAPE", () => {
      const bad = JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_x", part: null });
      const stdout = [bad].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
      }
    });

    it("text with invalid shape produces INVALID_EVENT_SHAPE", () => {
      const bad = JSON.stringify({ type: "text", timestamp: 1, sessionID: "ses_x", part: { id: "x", messageID: "m", sessionID: "ses_x", type: "text" } });
      const stdout = [bad].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
      }
    });

    it("step_finish with invalid shape produces INVALID_EVENT_SHAPE", () => {
      const bad = JSON.stringify({ type: "step_finish", timestamp: 1, sessionID: "ses_x", part: { id: "x", messageID: "m", sessionID: "ses_x", type: "step-finish" } });
      const stdout = [bad].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
      }
    });

    it("sessionID mismatch between top-level and part produces INVALID_EVENT_SHAPE", () => {
      const bad = JSON.stringify({
        type: "step_start",
        timestamp: 1,
        sessionID: "ses_top",
        part: { id: "x", messageID: "m", sessionID: "ses_part", type: "step-start" },
      });
      const stdout = [bad].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
      }
    });

    it("missing text events produces MISSING_ASSISTANT_OUTPUT", () => {
      const stdout = [STEP_START, STEP_FINISH].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("MISSING_ASSISTANT_OUTPUT");
      }
    });
  });

  describe("pre-parse guards", () => {
    it("stdoutTruncated produces TRUNCATED_OUTPUT", () => {
      expect(() =>
        parseOpenCodeOutput(makeResult({ stdout: "anything", stdoutTruncated: true })),
      ).toThrow(OpenCodeOutputParseError);

      try {
        parseOpenCodeOutput(makeResult({ stdout: "anything", stdoutTruncated: true }));
      } catch (error) {
        expect((error as OpenCodeOutputParseError).code).toBe("TRUNCATED_OUTPUT");
      }
    });

    it("timedOut produces TIMED_OUT_PROCESS", () => {
      expect(() =>
        parseOpenCodeOutput(makeResult({ stdout: "anything", timedOut: true })),
      ).toThrow(OpenCodeOutputParseError);

      try {
        parseOpenCodeOutput(makeResult({ stdout: "anything", timedOut: true }));
      } catch (error) {
        expect((error as OpenCodeOutputParseError).code).toBe("TIMED_OUT_PROCESS");
      }
    });

    it("aborted produces ABORTED_PROCESS", () => {
      expect(() =>
        parseOpenCodeOutput(makeResult({ stdout: "anything", aborted: true })),
      ).toThrow(OpenCodeOutputParseError);

      try {
        parseOpenCodeOutput(makeResult({ stdout: "anything", aborted: true }));
      } catch (error) {
        expect((error as OpenCodeOutputParseError).code).toBe("ABORTED_PROCESS");
      }
    });
  });

  describe("process metadata passthrough", () => {
    it("non-zero exit with valid stdout parses", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout, exitCode: 1 }));

      expect(result.assistantText).toBe("READY");
    });

    it("stderr not empty with valid stdout parses", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout, stderr: "warn: provider throttled" }));

      expect(result.assistantText).toBe("READY");
      expect(result.stderr).toBe("warn: provider throttled");
    });
  });

  describe("event field validation", () => {
    it("accepts valid time fields", () => {
      const text = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: {
          id: "t1", messageID: "msg_m", sessionID: "ses_x", type: "text", text: "hi",
          time: { start: 100, end: 200 },
        },
      });
      const stdout = [text].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.assistantText).toBe("hi");
    });

    it("accepts valid metadata", () => {
      const text = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_x",
        part: {
          id: "t1", messageID: "msg_m", sessionID: "ses_x", type: "text", text: "hi",
          metadata: { provider: "openai", phase: "final_answer" },
        },
      });
      const stdout = [text].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.assistantText).toBe("hi");
    });

    it("accepts valid tokens", () => {
      const finish = JSON.stringify({
        type: "step_finish",
        timestamp: 1,
        sessionID: "ses_x",
        part: {
          id: "f1", messageID: "msg_m", sessionID: "ses_x", type: "step-finish", reason: "stop",
          tokens: { total: 100, input: 80, output: 20, reasoning: 0, cache: { write: 0, read: 0 } },
          cost: 0.001,
        },
      });
      const stdout = [TEXT_READY, finish].join("\n");
      const result = parseOpenCodeOutput(makeResult({ stdout }));

      expect(result.finished).toBe(true);
    });

    it("rejects negative tokens.input", () => {
      const finish = JSON.stringify({
        type: "step_finish",
        timestamp: 1,
        sessionID: "ses_x",
        part: {
          id: "f1", messageID: "msg_m", sessionID: "ses_x", type: "step-finish", reason: "stop",
          tokens: { total: 100, input: -1, output: 20, reasoning: 0, cache: { write: 0, read: 0 } },
        },
      });
      const stdout = [TEXT_READY, finish].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
      }
    });

    it("rejects negative cost", () => {
      const finish = JSON.stringify({
        type: "step_finish",
        timestamp: 1,
        sessionID: "ses_x",
        part: {
          id: "f1", messageID: "msg_m", sessionID: "ses_x", type: "step-finish", reason: "stop",
          cost: -0.5,
        },
      });
      const stdout = [TEXT_READY, finish].join("\n");

      try {
        parseOpenCodeOutput(makeResult({ stdout }));
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeOutputParseError);
        expect((error as OpenCodeOutputParseError).code).toBe("INVALID_EVENT_SHAPE");
      }
    });
  });

  describe("immutability", () => {
    it("does not mutate input", () => {
      const stdout = [STEP_START, TEXT_READY, STEP_FINISH].join("\n");
      const copy = stdout.slice();

      parseOpenCodeOutput(makeResult({ stdout }));

      expect(stdout).toBe(copy);
    });
  });
});
