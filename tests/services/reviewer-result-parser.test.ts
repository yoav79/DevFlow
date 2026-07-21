import { describe, expect, it } from "vitest";
import {
  parseReviewerResult,
  ReviewerResultValidationError,
} from "../../src/services/reviewer-result-parser.js";

// ---------------------------------------------------------------------------
// Valid fixtures
// ---------------------------------------------------------------------------

const validLowFinding = {
  code: "STYLE-001",
  severity: "LOW" as const,
  title: "Inconsistent naming",
  description: "Variable names do not follow convention",
};

const validMediumFinding = {
  code: "CORRECTNESS-001",
  severity: "MEDIUM" as const,
  title: "Missing null check",
  description: "Dereferencing potentially null value",
  filePath: "src/bar.ts",
  lineStart: 42,
  evidence: "user.name.trim()",
};

const validHighFinding = {
  code: "SECURITY-001",
  severity: "HIGH" as const,
  title: "SQL injection",
  description: "Unsanitized input in query",
};

const validCriticalFinding = {
  code: "CRITICAL-001",
  severity: "CRITICAL" as const,
  title: "Data loss",
  description: "Unconditional delete of all rows",
};

const validApprovedResult = {
  verdict: "APPROVED" as const,
  summary: "Implementation looks correct",
  findings: [validLowFinding],
  requiredChanges: [],
};

const validRevisionRequiredResult = {
  verdict: "REVISION_REQUIRED" as const,
  summary: "Issues found that require changes",
  findings: [validMediumFinding],
  requiredChanges: [
    {
      code: "FIX-001",
      description: "Add null check before dereferencing",
      acceptanceCriteria: ["user is checked for null before access"],
      relatedFindingCodes: ["CORRECTNESS-001"],
    },
  ],
};

// ---------------------------------------------------------------------------
// parseReviewerResult — valid results
// ---------------------------------------------------------------------------

describe("parseReviewerResult", () => {
  describe("valid results", () => {
    // 31. parseReviewerResult devuelve tipo APPROVED discriminado
    it("returns a typed APPROVED result", () => {
      const result = parseReviewerResult(validApprovedResult);
      expect(result.verdict).toBe("APPROVED");
      if (result.verdict === "APPROVED") {
        expect(result.requiredChanges).toEqual([]);
        expect(result.findings).toHaveLength(1);
      }
    });

    // 32. parseReviewerResult devuelve tipo REVISION_REQUIRED discriminado
    it("returns a typed REVISION_REQUIRED result", () => {
      const result = parseReviewerResult(validRevisionRequiredResult);
      expect(result.verdict).toBe("REVISION_REQUIRED");
      if (result.verdict === "REVISION_REQUIRED") {
        expect(result.requiredChanges).toHaveLength(1);
        expect(result.findings).toHaveLength(1);
      }
    });

    it("preserves valid data without normalizing", () => {
      const result = parseReviewerResult(validApprovedResult);
      expect(result).toEqual(validApprovedResult);
    });

    it("does not modify the input object", () => {
      const input = { ...validApprovedResult };
      const copy = JSON.parse(JSON.stringify(input));
      parseReviewerResult(input);
      expect(input).toEqual(copy);
    });

    it("accepts APPROVED with no findings", () => {
      const result = parseReviewerResult({
        verdict: "APPROVED",
        summary: "Perfect",
        findings: [],
        requiredChanges: [],
      });
      expect(result.verdict).toBe("APPROVED");
    });

    it("accepts REVISION_REQUIRED with multiple findings and requiredChanges", () => {
      const result = parseReviewerResult({
        verdict: "REVISION_REQUIRED",
        summary: "Multiple issues",
        findings: [validMediumFinding, validHighFinding, validCriticalFinding],
        requiredChanges: [
          {
            code: "FIX-MED",
            description: "Fix medium",
            acceptanceCriteria: ["Null check added"],
            relatedFindingCodes: ["CORRECTNESS-001"],
          },
          {
            code: "FIX-SEC",
            description: "Fix security",
            acceptanceCriteria: ["Input sanitized"],
            relatedFindingCodes: ["SECURITY-001", "CRITICAL-001"],
          },
        ],
      });
      expect(result.verdict).toBe("REVISION_REQUIRED");
      if (result.verdict === "REVISION_REQUIRED") {
        expect(result.findings).toHaveLength(3);
        expect(result.requiredChanges).toHaveLength(2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // parseReviewerResult — invalid results
  // ---------------------------------------------------------------------------

  describe("invalid results", () => {
    // 33. parseReviewerResult falla con JSON semánticamente inválido
    it("throws for APPROVED with MEDIUM finding", () => {
      expect(() =>
        parseReviewerResult({
          verdict: "APPROVED",
          summary: "Looks ok",
          findings: [validMediumFinding],
          requiredChanges: [],
        }),
      ).toThrow(ReviewerResultValidationError);
    });

    it("throws for null", () => {
      expect(() => parseReviewerResult(null)).toThrow(
        ReviewerResultValidationError,
      );
    });

    it("throws for unknown verdict", () => {
      expect(() =>
        parseReviewerResult({
          verdict: "UNKNOWN",
          summary: "Test",
          findings: [],
          requiredChanges: [],
        }),
      ).toThrow(ReviewerResultValidationError);
    });

    it("throws for object without verdict", () => {
      expect(() =>
        parseReviewerResult({ summary: "test", findings: [] }),
      ).toThrow(ReviewerResultValidationError);
    });

    it("throws for empty summary", () => {
      expect(() =>
        parseReviewerResult({
          verdict: "APPROVED",
          summary: "",
          findings: [],
          requiredChanges: [],
        }),
      ).toThrow(ReviewerResultValidationError);
    });

    it("throws for unknown property at root", () => {
      expect(() =>
        parseReviewerResult({
          verdict: "APPROVED",
          summary: "Test",
          findings: [],
          requiredChanges: [],
          extraField: "value",
        }),
      ).toThrow(ReviewerResultValidationError);
    });

    it("throws for REVISION_REQUIRED with only LOW findings", () => {
      expect(() =>
        parseReviewerResult({
          verdict: "REVISION_REQUIRED",
          summary: "Only low",
          findings: [validLowFinding],
          requiredChanges: [
            {
              code: "FIX-001",
              description: "Fix",
              acceptanceCriteria: ["Done"],
              relatedFindingCodes: ["STYLE-001"],
            },
          ],
        }),
      ).toThrow(ReviewerResultValidationError);
    });

    it("throws for uncovered MEDIUM finding", () => {
      expect(() =>
        parseReviewerResult({
          verdict: "REVISION_REQUIRED",
          summary: "Uncovered",
          findings: [validMediumFinding],
          requiredChanges: [
            {
              code: "FIX-001",
              description: "Fix",
              acceptanceCriteria: ["Done"],
              relatedFindingCodes: ["NONEXISTENT-001"],
            },
          ],
        }),
      ).toThrow(ReviewerResultValidationError);
    });
  });

  // ---------------------------------------------------------------------------
  // Error domain
  // ---------------------------------------------------------------------------

  describe("error domain", () => {
    it("has name ReviewerResultValidationError", () => {
      try {
        parseReviewerResult(null);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerResultValidationError);
        expect((error as ReviewerResultValidationError).name).toBe(
          "ReviewerResultValidationError",
        );
      }
    });

    it("extends Error", () => {
      try {
        parseReviewerResult(null);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });

    it("message contains the exact number of issues", () => {
      try {
        parseReviewerResult(null);
        expect.fail("should throw");
      } catch (error) {
        const err = error as ReviewerResultValidationError;
        expect(err.message).toBe(
          "Resultado del reviewer inválido: 1 error(es) de validación.",
        );
      }
    });

    it("issues contain path, code and message", () => {
      try {
        parseReviewerResult({ summary: "test" });
        expect.fail("should throw");
      } catch (error) {
        const err = error as ReviewerResultValidationError;
        expect(err.issues.length).toBeGreaterThan(0);
        const issue = err.issues[0];
        expect(issue).toBeDefined();
        expect(issue?.path).toBeDefined();
        expect(issue?.code).toBeDefined();
        expect(issue?.message).toBeDefined();
      }
    });

    it("issues array is an independent copy", () => {
      const originalIssues = [
        { path: ["field"], code: "invalid_type", message: "bad" },
      ];
      const error = new ReviewerResultValidationError(originalIssues);
      originalIssues.push({ path: ["other"], code: "extra", message: "extra" });
      expect(error.issues).toHaveLength(1);
    });

    it("path arrays are independent copies", () => {
      const originalPath = ["a", "b"];
      const error = new ReviewerResultValidationError([
        { path: originalPath, code: "test", message: "test" },
      ]);
      originalPath.push("c");
      expect(error.issues[0]?.path).toEqual(["a", "b"]);
    });

    it("two errors do not share mutable arrays", () => {
      const shared = [{ path: ["p"], code: "c", message: "m" }];
      const error1 = new ReviewerResultValidationError(shared);
      const error2 = new ReviewerResultValidationError(shared);
      shared.push({ path: ["q"], code: "d", message: "n" });
      expect(error1.issues).toHaveLength(1);
      expect(error2.issues).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // API surface
  // ---------------------------------------------------------------------------

  describe("API surface", () => {
    it("does not expose ZodError to the consumer", () => {
      try {
        parseReviewerResult(null);
        expect.fail("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerResultValidationError);
        expect((error as ReviewerResultValidationError).name).not.toBe(
          "ZodError",
        );
      }
    });

    it("does not return null or undefined for valid input", () => {
      const result = parseReviewerResult(validApprovedResult);
      expect(result).not.toBeNull();
      expect(result).not.toBeUndefined();
    });

    it("verdict narrowing works on return type", () => {
      const result = parseReviewerResult(validRevisionRequiredResult);
      switch (result.verdict) {
        case "APPROVED":
          expect(result.requiredChanges).toEqual([]);
          break;
        case "REVISION_REQUIRED":
          expect(result.requiredChanges.length).toBeGreaterThan(0);
          break;
        default: {
          const _exhaustive: never = result;
          expect(_exhaustive).toBeDefined();
        }
      }
    });

    it("can be caught with instanceof", () => {
      try {
        parseReviewerResult("invalid");
      } catch (error) {
        expect(error instanceof ReviewerResultValidationError).toBe(true);
      }
    });
  });
});
