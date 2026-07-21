import { reviewerResultSchema } from "../schemas/reviewer-result-schema.js";
import type { ReviewerResult } from "../schemas/reviewer-result-schema.js";

// ---------------------------------------------------------------------------
// Issue type (normalised from Zod)
// ---------------------------------------------------------------------------

export interface ReviewerValidationIssue {
  readonly path: Array<string | number>;
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ReviewerResultValidationError extends Error {
  readonly issues: ReviewerValidationIssue[];

  constructor(issues: ReviewerValidationIssue[]) {
    const count = issues.length;
    super(`Resultado del reviewer inválido: ${count} error(es) de validación.`);
    this.name = "ReviewerResultValidationError";
    this.issues = issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toValidationIssue(
  zodIssue: {
    path: readonly (string | number | symbol)[];
    code: string | number | symbol;
    message: string;
  },
): ReviewerValidationIssue {
  return {
    path: zodIssue.path.filter(
      (p): p is string | number =>
        typeof p === "string" || typeof p === "number",
    ),
    code: String(zodIssue.code),
    message: zodIssue.message,
  };
}

// ---------------------------------------------------------------------------
// parseReviewerResult
// ---------------------------------------------------------------------------

/**
 * Parse an unknown value into a validated `ReviewerResult`.
 *
 * Uses safeParse internally; never exposes ZodError to consumers.
 * Combines structural (Zod) and semantic (superRefine) validation.
 * Does not persist or modify state.
 */
export function parseReviewerResult(input: unknown): ReviewerResult {
  const result = reviewerResultSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map(toValidationIssue);
  throw new ReviewerResultValidationError(issues);
}
