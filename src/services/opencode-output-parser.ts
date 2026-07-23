/// <reference types="node" />

// ---------------------------------------------------------------------------
// Narrow input interface (subset of OpenCodeProcessResult — only fields the parser reads)
// ---------------------------------------------------------------------------

export interface OpenCodeOutputParseInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Transport event types
// ---------------------------------------------------------------------------

export interface OpenCodeStepStartEvent {
  readonly type: "step_start";
  readonly timestamp: number;
  readonly sessionID: string;
  readonly part: {
    readonly id: string;
    readonly messageID: string;
    readonly sessionID: string;
    readonly type: "step-start";
  };
}

export interface OpenCodeTextEvent {
  readonly type: "text";
  readonly timestamp: number;
  readonly sessionID: string;
  readonly part: {
    readonly id: string;
    readonly messageID: string;
    readonly sessionID: string;
    readonly type: "text";
    readonly text: string;
    readonly time?: {
      readonly start: number;
      readonly end?: number;
    };
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

export interface OpenCodeStepFinishEvent {
  readonly type: "step_finish";
  readonly timestamp: number;
  readonly sessionID: string;
  readonly part: {
    readonly id: string;
    readonly messageID: string;
    readonly sessionID: string;
    readonly type: "step-finish";
    readonly reason: string;
    readonly tokens?: {
      readonly total?: number;
      readonly input: number;
      readonly output: number;
      readonly reasoning: number;
      readonly cache: {
        readonly write: number;
        readonly read: number;
      };
    };
    readonly cost?: number;
  };
}

export interface OpenCodeUnknownEvent {
  readonly type: string;
  readonly timestamp?: number;
  readonly sessionID?: string;
  readonly raw: unknown;
}

export type OpenCodeTransportEvent =
  | OpenCodeStepStartEvent
  | OpenCodeTextEvent
  | OpenCodeStepFinishEvent
  | OpenCodeUnknownEvent;

// ---------------------------------------------------------------------------
// Parsed output
// ---------------------------------------------------------------------------

export interface ParsedOpenCodeOutput {
  readonly events: readonly OpenCodeTransportEvent[];
  readonly assistantText: string;
  readonly rawStdout: string;
  readonly stderr: string;
  readonly sessionID: string | null;
  readonly messageID: string;
  readonly finished: boolean;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type OpenCodeOutputParseErrorCode =
  | "EMPTY_OUTPUT"
  | "INVALID_JSON_LINE"
  | "INVALID_EVENT_SHAPE"
  | "MISSING_ASSISTANT_OUTPUT"
  | "TRUNCATED_OUTPUT"
  | "TIMED_OUT_PROCESS"
  | "ABORTED_PROCESS";

export class OpenCodeOutputParseError extends Error {
  readonly code: OpenCodeOutputParseErrorCode;
  readonly lineNumber?: number;

  constructor(
    message: string,
    options: {
      code: OpenCodeOutputParseErrorCode;
      lineNumber?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "OpenCodeOutputParseError";
    this.code = options.code;
    if (options.lineNumber !== undefined) {
      this.lineNumber = options.lineNumber;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNeg(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Per-type shape validators
// ---------------------------------------------------------------------------

function validateStepStart(event: Record<string, unknown>, raw: unknown, lineNumber: number): OpenCodeStepStartEvent {
  if (!isFiniteNumber(event.timestamp)) {
    throw new OpenCodeOutputParseError(
      "step_start: timestamp inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(event.sessionID)) {
    throw new OpenCodeOutputParseError(
      "step_start: sessionID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isRecord(event.part)) {
    throw new OpenCodeOutputParseError(
      "step_start: part inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  const part = event.part;

  if (!isNonEmptyString(part.id)) {
    throw new OpenCodeOutputParseError(
      "step_start: part.id inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.messageID)) {
    throw new OpenCodeOutputParseError(
      "step_start: part.messageID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.sessionID)) {
    throw new OpenCodeOutputParseError(
      "step_start: part.sessionID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.type !== "step-start") {
    throw new OpenCodeOutputParseError(
      "step_start: part.type esperado step-start",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.sessionID !== event.sessionID) {
    throw new OpenCodeOutputParseError(
      "step_start: sessionID mismatch",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  return raw as OpenCodeStepStartEvent;
}

function validateText(event: Record<string, unknown>, raw: unknown, lineNumber: number): OpenCodeTextEvent {
  if (!isFiniteNumber(event.timestamp)) {
    throw new OpenCodeOutputParseError(
      "text: timestamp inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(event.sessionID)) {
    throw new OpenCodeOutputParseError(
      "text: sessionID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isRecord(event.part)) {
    throw new OpenCodeOutputParseError(
      "text: part inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  const part = event.part;

  if (!isNonEmptyString(part.id)) {
    throw new OpenCodeOutputParseError(
      "text: part.id inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.messageID)) {
    throw new OpenCodeOutputParseError(
      "text: part.messageID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.sessionID)) {
    throw new OpenCodeOutputParseError(
      "text: part.sessionID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.type !== "text") {
    throw new OpenCodeOutputParseError(
      "text: part.type esperado text",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (typeof part.text !== "string") {
    throw new OpenCodeOutputParseError(
      "text: part.text inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.sessionID !== event.sessionID) {
    throw new OpenCodeOutputParseError(
      "text: sessionID mismatch",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.time !== undefined) {
    if (!isRecord(part.time)) {
      throw new OpenCodeOutputParseError(
        "text: time inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isFiniteNumber(part.time.start)) {
      throw new OpenCodeOutputParseError(
        "text: time.start inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (part.time.end !== undefined && !isFiniteNumber(part.time.end)) {
      throw new OpenCodeOutputParseError(
        "text: time.end inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
  }

  if (part.metadata !== undefined) {
    if (!isRecord(part.metadata)) {
      throw new OpenCodeOutputParseError(
        "text: metadata inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
  }

  return raw as OpenCodeTextEvent;
}

function validateStepFinish(event: Record<string, unknown>, raw: unknown, lineNumber: number): OpenCodeStepFinishEvent {
  if (!isFiniteNumber(event.timestamp)) {
    throw new OpenCodeOutputParseError(
      "step_finish: timestamp inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(event.sessionID)) {
    throw new OpenCodeOutputParseError(
      "step_finish: sessionID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isRecord(event.part)) {
    throw new OpenCodeOutputParseError(
      "step_finish: part inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  const part = event.part;

  if (!isNonEmptyString(part.id)) {
    throw new OpenCodeOutputParseError(
      "step_finish: part.id inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.messageID)) {
    throw new OpenCodeOutputParseError(
      "step_finish: part.messageID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.sessionID)) {
    throw new OpenCodeOutputParseError(
      "step_finish: part.sessionID inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.type !== "step-finish") {
    throw new OpenCodeOutputParseError(
      "step_finish: part.type esperado step-finish",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (!isNonEmptyString(part.reason)) {
    throw new OpenCodeOutputParseError(
      "step_finish: reason inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.sessionID !== event.sessionID) {
    throw new OpenCodeOutputParseError(
      "step_finish: sessionID mismatch",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  if (part.tokens !== undefined) {
    if (!isRecord(part.tokens)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isFiniteNonNeg(part.tokens.input)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.input inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isFiniteNonNeg(part.tokens.output)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.output inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isFiniteNonNeg(part.tokens.reasoning)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.reasoning inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (part.tokens.total !== undefined && !isFiniteNonNeg(part.tokens.total)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.total inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isRecord(part.tokens.cache)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.cache inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isFiniteNonNeg(part.tokens.cache.write)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.cache.write inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
    if (!isFiniteNonNeg(part.tokens.cache.read)) {
      throw new OpenCodeOutputParseError(
        "step_finish: tokens.cache.read inválido",
        { code: "INVALID_EVENT_SHAPE", lineNumber },
      );
    }
  }

  if (part.cost !== undefined && !isFiniteNonNeg(part.cost)) {
    throw new OpenCodeOutputParseError(
      "step_finish: cost inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  return raw as OpenCodeStepFinishEvent;
}

function validateUnknown(event: Record<string, unknown>, raw: unknown, lineNumber: number): OpenCodeUnknownEvent {
  const type = event.type;

  if (!isNonEmptyString(type)) {
    throw new OpenCodeOutputParseError(
      "Evento con type inválido",
      { code: "INVALID_EVENT_SHAPE", lineNumber },
    );
  }

  return {
    type,
    timestamp: isFiniteNumber(event.timestamp) ? (event.timestamp as number) : undefined,
    sessionID: isNonEmptyString(event.sessionID) ? event.sessionID : undefined,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseOpenCodeOutput(
  result: OpenCodeOutputParseInput,
): ParsedOpenCodeOutput {
  if (result.stdoutTruncated) {
    throw new OpenCodeOutputParseError(
      "El stdout fue truncado.",
      { code: "TRUNCATED_OUTPUT" },
    );
  }

  if (result.timedOut) {
    throw new OpenCodeOutputParseError(
      "El proceso excedió el timeout.",
      { code: "TIMED_OUT_PROCESS" },
    );
  }

  if (result.aborted) {
    throw new OpenCodeOutputParseError(
      "El proceso fue abortado.",
      { code: "ABORTED_PROCESS" },
    );
  }

  const trimmed = result.stdout.trim();

  if (trimmed.length === 0) {
    throw new OpenCodeOutputParseError(
      "El stdout está vacío.",
      { code: "EMPTY_OUTPUT" },
    );
  }

  const lines = result.stdout.split(/\r?\n/);
  const events: OpenCodeTransportEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new OpenCodeOutputParseError(
        `Línea ${i + 1}: JSON inválido`,
        { code: "INVALID_JSON_LINE", lineNumber: i + 1, cause },
      );
    }

    if (!isRecord(parsed)) {
      throw new OpenCodeOutputParseError(
        `Línea ${i + 1}: evento no es un objeto`,
        { code: "INVALID_EVENT_SHAPE", lineNumber: i + 1 },
      );
    }

    const type = parsed.type;

    if (type === "step_start") {
      events.push(validateStepStart(parsed, parsed, i + 1));
    } else if (type === "text") {
      events.push(validateText(parsed, parsed, i + 1));
    } else if (type === "step_finish") {
      events.push(validateStepFinish(parsed, parsed, i + 1));
    } else {
      events.push(validateUnknown(parsed, parsed, i + 1));
    }
  }

  // ---------------------------------------------------------------------------
  // Group text events by messageID, preserving order
  // ---------------------------------------------------------------------------

  const textGroups = new Map<string, { sessionID: string; texts: string[] }>();

  for (const event of events) {
    if (event.type === "text" && "part" in event) {
      const textEvent = event as OpenCodeTextEvent;
      const msgID = textEvent.part.messageID;
      const existing = textGroups.get(msgID);

      if (existing) {
        existing.texts.push(textEvent.part.text);
      } else {
        textGroups.set(msgID, {
          sessionID: textEvent.part.sessionID,
          texts: [textEvent.part.text],
        });
      }
    }
  }

  // Select the last group whose concatenated text is non-empty after trim
  let selectedMessageID: string | null = null;
  let selectedSessionID: string | null = null;
  let selectedTexts: string[] | null = null;

  for (const [msgID, group] of textGroups) {
    const joined = group.texts.join("");

    if (joined.trim().length > 0) {
      selectedMessageID = msgID;
      selectedSessionID = group.sessionID;
      selectedTexts = group.texts;
    }
  }

  if (selectedMessageID === null || selectedTexts === null || selectedSessionID === null) {
    throw new OpenCodeOutputParseError(
      "No se encontró texto del assistant.",
      { code: "MISSING_ASSISTANT_OUTPUT" },
    );
  }

  // Verify sessionID consistency across the selected group
  const textEventsForSelected = events.filter(
    (e): e is OpenCodeTextEvent => e.type === "text" && "part" in e && (e as OpenCodeTextEvent).part.messageID === selectedMessageID,
  );

  for (const e of textEventsForSelected) {
    if (e.part.sessionID !== selectedSessionID) {
      throw new OpenCodeOutputParseError(
        "sessionID inconsistente en eventos text.",
        { code: "INVALID_EVENT_SHAPE" },
      );
    }
  }

  const assistantText = selectedTexts.join("");

  // Determine finished
  const finished = events.some(
    (e) =>
      e.type === "step_finish" &&
      (e as OpenCodeStepFinishEvent).part.messageID === selectedMessageID,
  );

  return {
    events,
    assistantText,
    rawStdout: result.stdout,
    stderr: result.stderr,
    sessionID: selectedSessionID,
    messageID: selectedMessageID,
    finished,
  };
}
