import { supervisorResultSchema } from "../schemas/supervisor-result-schema.js";
import type { SupervisorResult } from "../types.js";

export interface SupervisorValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export class SupervisorResultValidationError extends Error {
  readonly issues: SupervisorValidationIssue[];

  constructor(issues: SupervisorValidationIssue[]) {
    const count = issues.length;
    super(`Resultado del supervisor inválido: ${count} error(es) de validación.`);
    this.name = "SupervisorResultValidationError";
    this.issues = issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
  }
}

function toValidationIssue(
  zodIssue: { path: readonly (string | number | symbol)[]; code: string | number | symbol; message: string },
): SupervisorValidationIssue {
  return {
    path: zodIssue.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number"),
    code: String(zodIssue.code),
    message: zodIssue.message,
  };
}

export function parseSupervisorResult(input: unknown): SupervisorResult {
  const result = supervisorResultSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map(toValidationIssue);
  throw new SupervisorResultValidationError(issues);
}
