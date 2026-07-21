import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, {
    message: "String must not be empty or whitespace only",
  });

// ---------------------------------------------------------------------------
// Finding severity
// ---------------------------------------------------------------------------

export const reviewerFindingSeveritySchema = z.enum([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
]);

export type ReviewerFindingSeverity = z.infer<typeof reviewerFindingSeveritySchema>;

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

export const reviewerFindingSchema = z
  .object({
    code: nonEmptyString,
    severity: reviewerFindingSeveritySchema,
    title: nonEmptyString,
    description: nonEmptyString,
    filePath: nonEmptyString.optional(),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    evidence: nonEmptyString.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Required change
// ---------------------------------------------------------------------------

export const reviewerRequiredChangeSchema = z
  .object({
    code: nonEmptyString,
    description: nonEmptyString,
    acceptanceCriteria: z.array(nonEmptyString).min(1),
    relatedFindingCodes: z.array(nonEmptyString).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Internal variant schemas (NOT exported — do not constitute complete contracts)
// ---------------------------------------------------------------------------

const approvedReviewerResultBaseSchema = z
  .object({
    verdict: z.literal("APPROVED"),
    summary: nonEmptyString,
    findings: z.array(reviewerFindingSchema),
    requiredChanges: z.tuple([]),
  })
  .strict();

const revisionRequiredReviewerResultBaseSchema = z
  .object({
    verdict: z.literal("REVISION_REQUIRED"),
    summary: nonEmptyString,
    findings: z.array(reviewerFindingSchema).min(1),
    requiredChanges: z.array(reviewerRequiredChangeSchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Discriminated union with semantic superRefine
// ---------------------------------------------------------------------------

/**
 * Regla de severidades para APPROVED:
 *
 * APPROVED permite únicamente findings con severity LOW.
 * Cualquier finding con severity MEDIUM, HIGH o CRITICAL exige REVISION_REQUIRED.
 *
 * Justificación: no existía precedente en el repositorio. Se adopta la regla
 * conservadora para evitar que resultados con problemas significativos se
 * aprueben silenciosamente. Un finding MEDIUM indica un problema que merece
 * atención antes de la siguiente ejecución del executor.
 *
 * Esta decisión se valida en tests explícitos.
 */
export const reviewerResultSchema = z
  .discriminatedUnion("verdict", [
    approvedReviewerResultBaseSchema,
    revisionRequiredReviewerResultBaseSchema,
  ])
  .superRefine((data, ctx) => {
    const findingCodes: string[] = data.findings.map((f) => f.code);
    const requiredChangeCodes: string[] = data.requiredChanges.map((rc) => rc.code);

    // --- Finding-level rules ---

    // Duplicate finding codes
    const seenFindingCodes = new Set<string>();
    for (let i = 0; i < findingCodes.length; i++) {
      const code = findingCodes[i]!;
      if (seenFindingCodes.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", i, "code"],
          message: `Código de finding duplicado: ${code}`,
        });
      } else {
        seenFindingCodes.add(code);
      }
    }

    // lineEnd without lineStart / lineEnd < lineStart
    for (let i = 0; i < data.findings.length; i++) {
      const finding = data.findings[i]!;
      if (finding.lineEnd !== undefined && finding.lineStart === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", i, "lineEnd"],
          message: "lineEnd no puede existir sin lineStart",
        });
      }
      if (
        finding.lineStart !== undefined &&
        finding.lineEnd !== undefined &&
        finding.lineEnd < finding.lineStart
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", i, "lineEnd"],
          message: "lineEnd no puede ser menor que lineStart",
        });
      }
    }

    // --- Required-change-level rules ---

    // Duplicate requiredChange codes
    const seenRequiredChangeCodes = new Set<string>();
    for (let i = 0; i < requiredChangeCodes.length; i++) {
      const code = requiredChangeCodes[i]!;
      if (seenRequiredChangeCodes.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredChanges", i, "code"],
          message: `Código de requiredChange duplicado: ${code}`,
        });
      } else {
        seenRequiredChangeCodes.add(code);
      }
    }

    // relatedFindingCodes: exist + no duplicates within same requiredChange
    for (let i = 0; i < data.requiredChanges.length; i++) {
      const rc = data.requiredChanges[i]!;
      const seenRefs = new Set<string>();
      for (let j = 0; j < rc.relatedFindingCodes.length; j++) {
        const refCode = rc.relatedFindingCodes[j]!;
        if (!findingCodes.includes(refCode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["requiredChanges", i, "relatedFindingCodes", j],
            message: `relatedFindingCode inexistente: ${refCode}`,
          });
        }
        if (seenRefs.has(refCode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["requiredChanges", i, "relatedFindingCodes", j],
            message: `relatedFindingCode duplicado: ${refCode}`,
          });
        } else {
          seenRefs.add(refCode);
        }
      }
    }

    // --- Verdict-specific rules ---

    if (data.verdict === "APPROVED") {
      // APPROVED permite únicamente findings LOW
      for (let i = 0; i < data.findings.length; i++) {
        const finding = data.findings[i]!;
        if (finding.severity !== "LOW") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["findings", i, "severity"],
            message: `APPROVED no puede contener findings con severity ${finding.severity}`,
          });
        }
      }
    }

    if (data.verdict === "REVISION_REQUIRED") {
      // Debe existir al menos un finding con severity MEDIUM, HIGH o CRITICAL
      const hasRelevantFinding = data.findings.some(
        (f) =>
          f.severity === "MEDIUM" ||
          f.severity === "HIGH" ||
          f.severity === "CRITICAL",
      );
      if (!hasRelevantFinding) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message:
            "REVISION_REQUIRED debe contener al menos un finding con severity MEDIUM, HIGH o CRITICAL",
        });
      }

      // Todo finding MEDIUM, HIGH o CRITICAL debe estar cubierto por al menos un requiredChange
      for (let i = 0; i < data.findings.length; i++) {
        const finding = data.findings[i]!;
        if (
          finding.severity === "MEDIUM" ||
          finding.severity === "HIGH" ||
          finding.severity === "CRITICAL"
        ) {
          const isCovered = data.requiredChanges.some((rc) =>
            rc.relatedFindingCodes.includes(finding.code),
          );
          if (!isCovered) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["findings", i, "severity"],
              message: `Finding ${finding.severity} "${finding.code}" no está cubierto por ningún requiredChange`,
            });
          }
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ReviewerFinding = z.infer<typeof reviewerFindingSchema>;
export type ReviewerRequiredChange = z.infer<typeof reviewerRequiredChangeSchema>;
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;

// Branch types derived from ReviewerResult via Extract
export type ApprovedReviewerResult = Extract<ReviewerResult, { verdict: "APPROVED" }>;
export type RevisionRequiredReviewerResult = Extract<ReviewerResult, { verdict: "REVISION_REQUIRED" }>;

// ---------------------------------------------------------------------------
// Compile-time bidirectional assertion: TaskReviewVerdict === ReviewerResult["verdict"]
// ---------------------------------------------------------------------------

import type { TaskReviewVerdict } from "../types.js";

type Assert<T extends true> = T;

type VerdictsMatch =
  [TaskReviewVerdict] extends [ReviewerResult["verdict"]]
    ? [ReviewerResult["verdict"]] extends [TaskReviewVerdict]
      ? true
      : false
    : false;

type _AssertVerdictsMatch = Assert<VerdictsMatch>;
