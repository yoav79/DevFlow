import { describe, expect, it } from "vitest";
import {
  reviewerFindingSeveritySchema,
  reviewerFindingSchema,
  reviewerRequiredChangeSchema,
  reviewerResultSchema,
} from "../../src/schemas/reviewer-result-schema.js";
import type {
  ReviewerFinding,
  ReviewerRequiredChange,
  ApprovedReviewerResult,
  RevisionRequiredReviewerResult,
  ReviewerResult,
} from "../../src/schemas/reviewer-result-schema.js";

// ---------------------------------------------------------------------------
// Valid fixtures
// ---------------------------------------------------------------------------

const validLowFinding: ReviewerFinding = {
  code: "STYLE-001",
  severity: "LOW",
  title: "Inconsistent naming",
  description: "Variable names do not follow convention",
  filePath: "src/foo.ts",
  lineStart: 10,
  lineEnd: 15,
  evidence: "const foo_bar = 1",
};

const validMediumFinding: ReviewerFinding = {
  code: "CORRECTNESS-001",
  severity: "MEDIUM",
  title: "Missing null check",
  description: "Dereferencing potentially null value",
  filePath: "src/bar.ts",
  lineStart: 42,
  evidence: "user.name.trim()",
};

const validHighFinding: ReviewerFinding = {
  code: "SECURITY-001",
  severity: "HIGH",
  title: "SQL injection",
  description: "Unsanitized input in query",
};

const validCriticalFinding: ReviewerFinding = {
  code: "CRITICAL-001",
  severity: "CRITICAL",
  title: "Data loss",
  description: "Unconditional delete of all rows",
};

const validRequiredChange: ReviewerRequiredChange = {
  code: "FIX-001",
  description: "Add null check before dereferencing",
  acceptanceCriteria: ["user is checked for null before access"],
  relatedFindingCodes: ["CORRECTNESS-001"],
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
  requiredChanges: [validRequiredChange],
};

// ---------------------------------------------------------------------------
// reviewerFindingSeveritySchema
// ---------------------------------------------------------------------------

describe("reviewerFindingSeveritySchema", () => {
  it("accepts CRITICAL", () => {
    expect(reviewerFindingSeveritySchema.safeParse("CRITICAL").success).toBe(true);
  });

  it("accepts HIGH", () => {
    expect(reviewerFindingSeveritySchema.safeParse("HIGH").success).toBe(true);
  });

  it("accepts MEDIUM", () => {
    expect(reviewerFindingSeveritySchema.safeParse("MEDIUM").success).toBe(true);
  });

  it("accepts LOW", () => {
    expect(reviewerFindingSeveritySchema.safeParse("LOW").success).toBe(true);
  });

  it("rejects INFO", () => {
    expect(reviewerFindingSeveritySchema.safeParse("INFO").success).toBe(false);
  });

  it("rejects unknown severity", () => {
    expect(reviewerFindingSeveritySchema.safeParse("UNKNOWN").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewerFindingSchema
// ---------------------------------------------------------------------------

describe("reviewerFindingSchema", () => {
  it("accepts a minimal finding (code, severity, title, description)", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "Title",
      description: "Description",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a complete finding with all optional fields", () => {
    const result = reviewerFindingSchema.safeParse(validLowFinding);
    expect(result.success).toBe(true);
  });

  it("rejects finding with empty code", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "",
      severity: "LOW",
      title: "Title",
      description: "Description",
    });
    expect(result.success).toBe(false);
  });

  it("rejects finding with empty title", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "",
      description: "Description",
    });
    expect(result.success).toBe(false);
  });

  it("rejects finding with empty description", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "Title",
      description: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects finding with empty filePath", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "Title",
      description: "Description",
      filePath: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects finding with empty evidence", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "Title",
      description: "Description",
      evidence: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects finding with lineStart 0", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "Title",
      description: "Description",
      lineStart: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown properties in finding", () => {
    const result = reviewerFindingSchema.safeParse({
      code: "X-001",
      severity: "LOW",
      title: "Title",
      description: "Description",
      unknownProp: "value",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewerRequiredChangeSchema
// ---------------------------------------------------------------------------

describe("reviewerRequiredChangeSchema", () => {
  it("accepts a valid requiredChange", () => {
    const result = reviewerRequiredChangeSchema.safeParse(validRequiredChange);
    expect(result.success).toBe(true);
  });

  it("rejects empty code", () => {
    const result = reviewerRequiredChangeSchema.safeParse({
      code: "",
      description: "Desc",
      acceptanceCriteria: ["criterion"],
      relatedFindingCodes: ["F-001"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty description", () => {
    const result = reviewerRequiredChangeSchema.safeParse({
      code: "FIX-001",
      description: "",
      acceptanceCriteria: ["criterion"],
      relatedFindingCodes: ["F-001"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty acceptanceCriteria array", () => {
    const result = reviewerRequiredChangeSchema.safeParse({
      code: "FIX-001",
      description: "Desc",
      acceptanceCriteria: [],
      relatedFindingCodes: ["F-001"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects acceptanceCriteria with empty string", () => {
    const result = reviewerRequiredChangeSchema.safeParse({
      code: "FIX-001",
      description: "Desc",
      acceptanceCriteria: [""],
      relatedFindingCodes: ["F-001"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty relatedFindingCodes array", () => {
    const result = reviewerRequiredChangeSchema.safeParse({
      code: "FIX-001",
      description: "Desc",
      acceptanceCriteria: ["criterion"],
      relatedFindingCodes: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown properties in requiredChange", () => {
    const result = reviewerRequiredChangeSchema.safeParse({
      code: "FIX-001",
      description: "Desc",
      acceptanceCriteria: ["criterion"],
      relatedFindingCodes: ["F-001"],
      unknownProp: "value",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewerResultSchema — valid cases
// ---------------------------------------------------------------------------

describe("reviewerResultSchema — valid cases", () => {
  it("accepts minimal APPROVED with no findings", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [],
      requiredChanges: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts APPROVED with LOW findings", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "Minor style issues only",
      findings: [validLowFinding],
      requiredChanges: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid REVISION_REQUIRED with MEDIUM finding and matching requiredChange", () => {
    const result = reviewerResultSchema.safeParse(validRevisionRequiredResult);
    expect(result.success).toBe(true);
  });

  it("accepts REVISION_REQUIRED with CRITICAL finding covered by requiredChange", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Critical issue found",
      findings: [validCriticalFinding],
      requiredChanges: [
        {
          code: "FIX-CRIT",
          description: "Fix data loss issue",
          acceptanceCriteria: ["All deletes are guarded"],
          relatedFindingCodes: ["CRITICAL-001"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts REVISION_REQUIRED with multiple findings and requiredChanges with correct cross-coverage", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Multiple issues",
      findings: [validMediumFinding, validHighFinding, validCriticalFinding],
      requiredChanges: [
        {
          code: "FIX-MED",
          description: "Fix medium issue",
          acceptanceCriteria: ["Null check added"],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
        {
          code: "FIX-SEC",
          description: "Fix security issue",
          acceptanceCriteria: ["Input is sanitized"],
          relatedFindingCodes: ["SECURITY-001", "CRITICAL-001"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts REVISION_REQUIRED with LOW finding not covered by requiredChange (allowed)", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues with uncovered LOW",
      findings: [validMediumFinding, validLowFinding],
      requiredChanges: [validRequiredChange],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reviewerResultSchema — APPROVED semantic failures
// ---------------------------------------------------------------------------

describe("reviewerResultSchema — APPROVED semantic failures", () => {
  it("rejects APPROVED with MEDIUM finding", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "Looks ok",
      findings: [validMediumFinding],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const severityIssue = result.error.issues.find(
        (i) => i.path.includes("severity") && i.path.includes("findings"),
      );
      expect(severityIssue).toBeDefined();
      expect(severityIssue?.message).toContain("MEDIUM");
    }
  });

  it("rejects APPROVED with HIGH finding", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "Looks ok",
      findings: [validHighFinding],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const severityIssue = result.error.issues.find(
        (i) => i.path.includes("severity") && i.path.includes("findings"),
      );
      expect(severityIssue).toBeDefined();
      expect(severityIssue?.message).toContain("HIGH");
    }
  });

  it("rejects APPROVED with CRITICAL finding", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "Looks ok",
      findings: [validCriticalFinding],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects APPROVED with non-empty requiredChanges", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "Looks ok",
      findings: [],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Desc",
          acceptanceCriteria: ["criterion"],
          relatedFindingCodes: ["F-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewerResultSchema — REVISION_REQUIRED semantic failures
// ---------------------------------------------------------------------------

describe("reviewerResultSchema — REVISION_REQUIRED semantic failures", () => {
  it("rejects REVISION_REQUIRED with empty findings", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [],
      requiredChanges: [validRequiredChange],
    });
    expect(result.success).toBe(false);
  });

  it("rejects REVISION_REQUIRED with empty requiredChanges", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [validMediumFinding],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects REVISION_REQUIRED with only LOW findings", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Only low issues",
      findings: [validLowFinding],
      requiredChanges: [
        {
          code: "FIX-LOW",
          description: "Fix low issue",
          acceptanceCriteria: ["Naming fixed"],
          relatedFindingCodes: ["STYLE-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const findingsIssue = result.error.issues.find(
        (i) => i.path.length === 1 && i.path[0] === "findings",
      );
      expect(findingsIssue).toBeDefined();
      expect(findingsIssue?.message).toContain("MEDIUM, HIGH o CRITICAL");
    }
  });

  it("rejects REVISION_REQUIRED with MEDIUM finding not covered by any requiredChange", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Uncovered medium",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "FIX-OTHER",
          description: "Fix something else",
          acceptanceCriteria: ["Other fixed"],
          relatedFindingCodes: ["NONEXISTENT-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const coverageIssue = result.error.issues.find(
        (i) =>
          i.path.includes("severity") &&
          i.path.includes("findings") &&
          i.message.includes("no está cubierto"),
      );
      expect(coverageIssue).toBeDefined();
    }
  });

  it("rejects REVISION_REQUIRED with HIGH finding not covered", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Uncovered high",
      findings: [validHighFinding],
      requiredChanges: [
        {
          code: "FIX-MED",
          description: "Fix something",
          acceptanceCriteria: ["Done"],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects REVISION_REQUIRED with CRITICAL finding not covered", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Uncovered critical",
      findings: [validCriticalFinding],
      requiredChanges: [
        {
          code: "FIX-MED",
          description: "Fix something",
          acceptanceCriteria: ["Done"],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewerResultSchema — cross-reference failures
// ---------------------------------------------------------------------------

describe("reviewerResultSchema — cross-reference failures", () => {
  it("rejects when relatedFindingCode references non-existent finding", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Fix",
          acceptanceCriteria: ["Fixed"],
          relatedFindingCodes: ["NONEXISTENT-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const refIssue = result.error.issues.find((i) =>
        i.message.includes("relatedFindingCode inexistente"),
      );
      expect(refIssue).toBeDefined();
    }
  });

  it("rejects duplicate finding codes", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [
        { code: "DUP-001", severity: "MEDIUM", title: "A", description: "A" },
        { code: "DUP-001", severity: "HIGH", title: "B", description: "B" },
      ],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Fix",
          acceptanceCriteria: ["Fixed"],
          relatedFindingCodes: ["DUP-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const dupIssue = result.error.issues.find((i) =>
        i.message.includes("Código de finding duplicado"),
      );
      expect(dupIssue).toBeDefined();
    }
  });

  it("rejects duplicate requiredChange codes", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "DUP-RC",
          description: "Fix A",
          acceptanceCriteria: ["A fixed"],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
        {
          code: "DUP-RC",
          description: "Fix B",
          acceptanceCriteria: ["B fixed"],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const dupIssue = result.error.issues.find((i) =>
        i.message.includes("Código de requiredChange duplicado"),
      );
      expect(dupIssue).toBeDefined();
    }
  });

  it("rejects duplicate relatedFindingCodes within same requiredChange", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Fix",
          acceptanceCriteria: ["Fixed"],
          relatedFindingCodes: ["CORRECTNESS-001", "CORRECTNESS-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const dupIssue = result.error.issues.find((i) =>
        i.message.includes("relatedFindingCode duplicado"),
      );
      expect(dupIssue).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// reviewerResultSchema — field-level validation
// ---------------------------------------------------------------------------

describe("reviewerResultSchema — field-level validation", () => {
  it("rejects empty acceptanceCriteria array", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Fix",
          acceptanceCriteria: [],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string in acceptanceCriteria", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues found",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Fix",
          acceptanceCriteria: [""],
          relatedFindingCodes: ["CORRECTNESS-001"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects lineStart 0", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", lineStart: 0 },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects lineEnd without lineStart", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", lineEnd: 10 },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const lineEndIssue = result.error.issues.find((i) =>
        i.message.includes("lineEnd no puede existir sin lineStart"),
      );
      expect(lineEndIssue).toBeDefined();
    }
  });

  it("rejects lineEnd less than lineStart", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", lineStart: 20, lineEnd: 10 },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const lineEndIssue = result.error.issues.find((i) =>
        i.message.includes("lineEnd no puede ser menor que lineStart"),
      );
      expect(lineEndIssue).toBeDefined();
    }
  });

  it("rejects empty filePath", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", filePath: "" },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty evidence", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", evidence: "" },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty summary", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "",
      findings: [],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown verdict", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "UNKNOWN",
      summary: "Test",
      findings: [],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown properties at root level", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [],
      requiredChanges: [],
      unknownRoot: "value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown properties in finding", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", extra: "bad" },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown properties in requiredChange", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED",
      summary: "Issues",
      findings: [validMediumFinding],
      requiredChanges: [
        {
          code: "FIX-001",
          description: "Fix",
          acceptanceCriteria: ["Done"],
          relatedFindingCodes: ["CORRECTNESS-001"],
          unknownField: "bad",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects string numbers where integers are expected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED",
      summary: "All good",
      findings: [
        { code: "X-001", severity: "LOW", title: "T", description: "D", lineStart: "10" },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    expect(reviewerResultSchema.safeParse(null).success).toBe(false);
  });

  it("rejects array as root", () => {
    expect(reviewerResultSchema.safeParse([]).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bypass regression: 12 tests confirming variant schemas cannot elude rules
// ---------------------------------------------------------------------------

describe("bypass regression — semantic rules enforced via reviewerResultSchema", () => {
  // APPROVED bypasses (6)
  it("APPROVED + MEDIUM finding is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED", summary: "Test",
      findings: [{ code: "M-001", severity: "MEDIUM", title: "T", description: "D" }],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("APPROVED + HIGH finding is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED", summary: "Test",
      findings: [{ code: "H-001", severity: "HIGH", title: "T", description: "D" }],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("APPROVED + CRITICAL finding is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED", summary: "Test",
      findings: [{ code: "C-001", severity: "CRITICAL", title: "T", description: "D" }],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("APPROVED + duplicate finding codes is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED", summary: "Test",
      findings: [
        { code: "D-001", severity: "LOW", title: "A", description: "A" },
        { code: "D-001", severity: "LOW", title: "B", description: "B" },
      ],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("APPROVED + lineEnd without lineStart is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED", summary: "Test",
      findings: [{ code: "L-001", severity: "LOW", title: "T", description: "D", lineEnd: 10 }],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  it("APPROVED + lineEnd less than lineStart is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "APPROVED", summary: "Test",
      findings: [{ code: "L-001", severity: "LOW", title: "T", description: "D", lineStart: 20, lineEnd: 10 }],
      requiredChanges: [],
    });
    expect(result.success).toBe(false);
  });

  // REVISION_REQUIRED bypasses (6)
  it("REVISION_REQUIRED + only LOW findings is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED", summary: "Test",
      findings: [{ code: "L-001", severity: "LOW", title: "T", description: "D" }],
      requiredChanges: [
        { code: "FIX-001", description: "Fix", acceptanceCriteria: ["Done"], relatedFindingCodes: ["L-001"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REVISION_REQUIRED + MEDIUM without coverage is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED", summary: "Test",
      findings: [{ code: "M-001", severity: "MEDIUM", title: "T", description: "D" }],
      requiredChanges: [
        { code: "FIX-001", description: "Fix", acceptanceCriteria: ["Done"], relatedFindingCodes: ["NONEXISTENT"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REVISION_REQUIRED + nonexistent relatedFindingCode is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED", summary: "Test",
      findings: [{ code: "M-001", severity: "MEDIUM", title: "T", description: "D" }],
      requiredChanges: [
        { code: "FIX-001", description: "Fix", acceptanceCriteria: ["Done"], relatedFindingCodes: ["DOESNOTEXIST-001"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REVISION_REQUIRED + duplicate requiredChange codes is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED", summary: "Test",
      findings: [{ code: "M-001", severity: "MEDIUM", title: "T", description: "D" }],
      requiredChanges: [
        { code: "FIX-001", description: "A", acceptanceCriteria: ["Done"], relatedFindingCodes: ["M-001"] },
        { code: "FIX-001", description: "B", acceptanceCriteria: ["Done"], relatedFindingCodes: ["M-001"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REVISION_REQUIRED + lineEnd less than lineStart is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED", summary: "Test",
      findings: [{ code: "M-001", severity: "MEDIUM", title: "T", description: "D", lineStart: 20, lineEnd: 10 }],
      requiredChanges: [
        { code: "FIX-001", description: "Fix", acceptanceCriteria: ["Done"], relatedFindingCodes: ["M-001"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REVISION_REQUIRED + duplicate finding codes is rejected", () => {
    const result = reviewerResultSchema.safeParse({
      verdict: "REVISION_REQUIRED", summary: "Test",
      findings: [
        { code: "D-001", severity: "MEDIUM", title: "A", description: "A" },
        { code: "D-001", severity: "HIGH", title: "B", description: "B" },
      ],
      requiredChanges: [
        { code: "FIX-001", description: "Fix", acceptanceCriteria: ["Done"], relatedFindingCodes: ["D-001"] },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Module surface: exported symbols
// ---------------------------------------------------------------------------

describe("module surface — exported symbols", () => {
  it("exports reviewerFindingSeveritySchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect(mod.reviewerFindingSeveritySchema).toBeDefined();
  });

  it("exports reviewerFindingSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect(mod.reviewerFindingSchema).toBeDefined();
  });

  it("exports reviewerRequiredChangeSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect(mod.reviewerRequiredChangeSchema).toBeDefined();
  });

  it("exports reviewerResultSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect(mod.reviewerResultSchema).toBeDefined();
  });

  it("does NOT export approvedReviewerResultSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect((mod as Record<string, unknown>).approvedReviewerResultSchema).toBeUndefined();
  });

  it("does NOT export revisionRequiredReviewerResultSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect((mod as Record<string, unknown>).revisionRequiredReviewerResultSchema).toBeUndefined();
  });

  it("does NOT export approvedReviewerResultBaseSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect((mod as Record<string, unknown>).approvedReviewerResultBaseSchema).toBeUndefined();
  });

  it("does NOT export revisionRequiredReviewerResultBaseSchema", async () => {
    const mod = await import("../../src/schemas/reviewer-result-schema.js");
    expect((mod as Record<string, unknown>).revisionRequiredReviewerResultBaseSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Public types: discriminant narrowing
// ---------------------------------------------------------------------------

describe("public types — discriminant narrowing", () => {
  it("APPROVED result has empty requiredChanges", () => {
    const result = reviewerResultSchema.parse(validApprovedResult) as ReviewerResult;
    expect(result.verdict).toBe("APPROVED");
    if (result.verdict === "APPROVED") {
      const approved = result as ApprovedReviewerResult;
      expect(approved.requiredChanges).toEqual([]);
      expect(Array.isArray(approved.findings)).toBe(true);
    }
  });

  it("REVISION_REQUIRED result has structured requiredChanges", () => {
    const result = reviewerResultSchema.parse(validRevisionRequiredResult) as ReviewerResult;
    expect(result.verdict).toBe("REVISION_REQUIRED");
    if (result.verdict === "REVISION_REQUIRED") {
      const rr = result as RevisionRequiredReviewerResult;
      expect(rr.requiredChanges.length).toBeGreaterThan(0);
      expect(rr.requiredChanges[0]?.code).toBeDefined();
      expect(rr.requiredChanges[0]?.acceptanceCriteria).toBeDefined();
    }
  });

  it("only two verdicts exist: APPROVED and REVISION_REQUIRED", () => {
    const allVerdicts = ["APPROVED", "REVISION_REQUIRED"] as const;
    for (const v of allVerdicts) {
      const input = v === "APPROVED"
        ? { verdict: "APPROVED", summary: "Test", findings: [], requiredChanges: [] }
        : {
            verdict: "REVISION_REQUIRED", summary: "Test",
            findings: [{ code: "M-001", severity: "MEDIUM" as const, title: "T", description: "D" }],
            requiredChanges: [{ code: "FIX-001", description: "Fix", acceptanceCriteria: ["Done"], relatedFindingCodes: ["M-001"] }],
          };
      const result = reviewerResultSchema.parse(input) as ReviewerResult;
      expect(result.verdict).toBe(v);
    }
  });
});
