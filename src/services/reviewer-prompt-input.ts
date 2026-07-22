import { ZodError } from "zod";

import {
  reviewerPromptInputSchema,
  reviewerPromptInputSourceSchema,
} from "../schemas/reviewer-prompt-input-schema.js";
import type { ReviewerPromptInput } from "../schemas/reviewer-prompt-input-schema.js";
import { EvidenceBundleError, verifyEvidenceBundle } from "./evidence-bundle-service.js";

export type ReviewerPromptInputErrorCode =
  | "INVALID_INPUT"
  | "EVIDENCE_IDENTITY_MISMATCH";

export class ReviewerPromptInputError extends Error {
  readonly code: ReviewerPromptInputErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      readonly code: ReviewerPromptInputErrorCode;
      readonly cause?: unknown;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReviewerPromptInputError";
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

export interface ReviewerPromptInputDeps {
  readonly verifyEvidenceBundle?: typeof verifyEvidenceBundle;
}

function toSchemaErrors(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function buildReviewerPromptInput(
  input: unknown,
  deps: ReviewerPromptInputDeps = {},
): ReviewerPromptInput {
  const sourceResult = reviewerPromptInputSourceSchema.safeParse(input);
  if (!sourceResult.success) {
    throw new ReviewerPromptInputError("ReviewerPromptInput source inválido.", {
      code: "INVALID_INPUT",
      cause: sourceResult.error,
      details: { schemaErrors: toSchemaErrors(sourceResult.error) },
    });
  }

  const source = sourceResult.data;
  const verifyBundle = deps.verifyEvidenceBundle ?? verifyEvidenceBundle;
  let verifiedBundle: ReviewerPromptInput["evidenceBundle"];
  try {
    verifiedBundle = verifyBundle(source.evidenceBundle);
  } catch (error) {
    if (error instanceof EvidenceBundleError) {
      throw error;
    }

    throw new ReviewerPromptInputError("No se pudo verificar el EvidenceBundle del reviewer prompt input.", {
      code: "INVALID_INPUT",
      cause: error,
    });
  }

  for (let i = 0; i < verifiedBundle.body.previousCorrections.length; i++) {
    const correction = verifiedBundle.body.previousCorrections[i]!;
    if (correction.reviewNumber >= source.reviewNumber) {
      throw new ReviewerPromptInputError("previousCorrection no es previa al review actual.", {
        code: "EVIDENCE_IDENTITY_MISMATCH",
        details: {
          reviewNumber: source.reviewNumber,
          offendingPreviousReviewNumber: correction.reviewNumber,
          correctionIndex: i,
          bundleDigest: verifiedBundle.bundleDigest,
        },
      });
    }
  }

  const output = {
    version: 1,
    reviewNumber: source.reviewNumber,
    evidenceBundle: verifiedBundle,
  };

  const outputResult = reviewerPromptInputSchema.safeParse(output);
  if (!outputResult.success) {
    throw new ReviewerPromptInputError("ReviewerPromptInput construido inválido.", {
      code: "INVALID_INPUT",
      cause: outputResult.error,
      details: { schemaErrors: toSchemaErrors(outputResult.error) },
    });
  }

  return outputResult.data;
}
