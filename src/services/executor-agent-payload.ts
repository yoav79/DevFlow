import { z } from "zod";
import {
  assertAgentEnvelopeRole,
  type AgentEnvelope,
} from "./agent-protocol.js";

const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "String must not be empty or whitespace only",
  });

export interface ExecutorAgentPayload {
  readonly filesClaimed: readonly string[];
  readonly commandsClaimed: readonly string[];
}

export interface ExecutorPayloadIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export const executorAgentPayloadSchema: z.ZodType<ExecutorAgentPayload> = z
  .object({
    filesClaimed: z.array(nonEmptyString),
    commandsClaimed: z.array(nonEmptyString),
  })
  .strict();

export class ExecutorPayloadValidationError extends Error {
  readonly issues: readonly ExecutorPayloadIssue[];

  constructor(
    issues: ExecutorPayloadIssue[],
    options?: { cause?: unknown },
  ) {
    const count = issues.length;
    super(`Payload del executor inválido: ${count} error(es) de validación.`);
    this.name = "ExecutorPayloadValidationError";
    this.issues = issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class ExecutorPayloadSemanticError extends Error {
  readonly issues: readonly ExecutorPayloadIssue[];

  constructor(
    issues: ExecutorPayloadIssue[],
    options?: { cause?: unknown },
  ) {
    const count = issues.length;
    super(`Payload del executor semánticamente inválido: ${count} error(es).`);
    this.name = "ExecutorPayloadSemanticError";
    this.issues = issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function normaliseZodIssues(
  issues: readonly z.ZodIssue[],
): ExecutorPayloadIssue[] {
  return issues.map((issue) => ({
    path: issue.path.filter(
      (part): part is string | number =>
        typeof part === "string" || typeof part === "number",
    ),
    code: issue.code,
    message: issue.message,
  }));
}

function findDuplicateValues(
  field: "filesClaimed" | "commandsClaimed",
  values: readonly string[],
): ExecutorPayloadIssue[] {
  const issues: ExecutorPayloadIssue[] = [];

  for (let index = 1; index < values.length; index++) {
    const current = values[index];

    for (let previousIndex = 0; previousIndex < index; previousIndex++) {
      if (current === values[previousIndex]) {
        issues.push({
          path: [field, index],
          code: "DUPLICATE_VALUE",
          message: `Valor duplicado en ${field}: ${current}. Ya apareció previamente.`,
        });
        break;
      }
    }
  }

  return issues;
}

function validateExecutorPayloadSemantics(
  payload: ExecutorAgentPayload,
): ExecutorAgentPayload {
  const issues = [
    ...findDuplicateValues("filesClaimed", payload.filesClaimed),
    ...findDuplicateValues("commandsClaimed", payload.commandsClaimed),
  ];

  if (issues.length > 0) {
    throw new ExecutorPayloadSemanticError(issues);
  }

  return payload;
}

export function parseExecutorPayload(
  payload: unknown,
): ExecutorAgentPayload {
  const result = executorAgentPayloadSchema.safeParse(payload);

  if (!result.success) {
    throw new ExecutorPayloadValidationError(
      normaliseZodIssues(result.error.issues),
      { cause: result.error },
    );
  }

  return validateExecutorPayloadSemantics(result.data as ExecutorAgentPayload);
}

export function parseExecutorAgentResult(
  envelope: AgentEnvelope,
): ExecutorAgentPayload {
  assertAgentEnvelopeRole(envelope, "executor");
  return parseExecutorPayload(envelope.payload);
}
