import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createEvidenceBundle, EvidenceBundleError } from "../../src/services/evidence-bundle-service.js";
import { buildReviewerPromptInput, ReviewerPromptInputError } from "../../src/services/reviewer-prompt-input.js";
import type {
  ReviewerPromptInputDeps,
  ReviewerPromptInputErrorCode,
} from "../../src/services/reviewer-prompt-input.js";
import type {
  ApprovedContractEvidence,
  DeterministicRevisionEvidence,
  EvidenceBundle,
  EvidenceBundleBody,
  EvidenceFile,
  PreviousCorrection,
} from "../../src/schemas/evidence-bundle-schema.js";
import type { ReviewerPromptInput } from "../../src/schemas/reviewer-prompt-input-schema.js";

const H40 = "a".repeat(40);
const H40_B = "b".repeat(40);
const H40_C = "c".repeat(40);
const H64 = "d".repeat(64);
const H64_B = "e".repeat(64);
const H64_C = "f".repeat(64);

function makeApprovedContract(overrides?: Partial<ApprovedContractEvidence>): ApprovedContractEvidence {
  return {
    objective: "Implement feature",
    context: "Project needs it",
    acceptanceCriteria: ["Works correctly"],
    allowedPaths: ["src"],
    forbiddenPaths: ["dist"],
    requiredCommands: ["npm test"],
    assumptions: ["Node installed"],
    risks: ["None"],
    ...overrides,
  };
}

function makeDeterministicRevision(
  overrides?: Partial<DeterministicRevisionEvidence>,
): DeterministicRevisionEvidence {
  return {
    status: "REVIEWING",
    pathValidation: { passed: true, violations: [] },
    commandsResult: null,
    ...overrides,
  };
}

function makePreviousCorrection(overrides?: Partial<PreviousCorrection>): PreviousCorrection {
  return {
    reviewNumber: 1,
    verdict: "REVISION_REQUIRED",
    summary: "Issues found",
    findings: [{
      code: `F-${overrides?.reviewNumber ?? 1}`,
      severity: "MEDIUM",
      title: "Issue",
      description: "Description",
    }],
    requiredChanges: [{
      code: `FIX-${overrides?.reviewNumber ?? 1}`,
      description: "Fix it",
      acceptanceCriteria: ["Fixed"],
      relatedFindingCodes: [`F-${overrides?.reviewNumber ?? 1}`],
    }],
    ...overrides,
  };
}

function makeTextModified(path = "src/existing.ts"): EvidenceFile {
  return {
    fileKind: "TEXT",
    status: "MODIFIED",
    path,
    previousMode: "100644",
    currentMode: "100755",
    previousObjectId: H40_C,
    patch: "@@ -1 +1 @@\n-old\n+new",
    currentHash: H64,
    previousHash: H64_B,
    currentByteLength: 20,
    previousByteLength: 15,
    currentContent: "new content",
    currentContentTruncated: false,
  };
}

function makeBody(overrides?: Partial<EvidenceBundleBody>): EvidenceBundleBody {
  return {
    version: 1,
    baseCommit: H40,
    headCommit: H40_B,
    workspaceFingerprint: H64,
    files: [],
    deterministicRevision: makeDeterministicRevision(),
    previousCorrections: [],
    approvedContract: makeApprovedContract(),
    ...overrides,
  };
}

function makeBundle(body: EvidenceBundleBody = makeBody()): EvidenceBundle {
  return createEvidenceBundle(body);
}

function expectPromptInputError(
  fn: () => unknown,
  code: ReviewerPromptInputErrorCode,
): ReviewerPromptInputError {
  try {
    fn();
    expect.fail("Expected ReviewerPromptInputError");
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerPromptInputError);
    expect((error as ReviewerPromptInputError).code).toBe(code);
    return error as ReviewerPromptInputError;
  }
}

describe("buildReviewerPromptInput", () => {
  it("has the expected public types", () => {
    expectTypeOf(buildReviewerPromptInput).returns.toEqualTypeOf<ReviewerPromptInput>();
    expectTypeOf<ReviewerPromptInputDeps>().toEqualTypeOf<{
      readonly verifyEvidenceBundle?: ((input: unknown) => EvidenceBundle) | undefined;
    }>();
    expectTypeOf<ReviewerPromptInputErrorCode>().toEqualTypeOf<
      | "INVALID_INPUT"
      | "EVIDENCE_IDENTITY_MISMATCH"
    >();
  });

  it("returns version 1 for a valid bundle with reviewNumber 1 and no previousCorrections", () => {
    const bundle = makeBundle();
    const result = buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 1 });

    expect(result.version).toBe(1);
    expect(result.reviewNumber).toBe(1);
    expect(result.evidenceBundle.bundleDigest).toBe(bundle.bundleDigest);
  });

  it("accepts a later reviewNumber with valid previousCorrections", () => {
    const bundle = makeBundle(makeBody({ previousCorrections: [makePreviousCorrection({ reviewNumber: 1 })] }));
    const result = buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 2 });

    expect(result.evidenceBundle.body.previousCorrections).toHaveLength(1);
  });

  it("preserves bundleDigest", () => {
    const bundle = makeBundle();
    const result = buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 1 });

    expect(result.evidenceBundle.bundleDigest).toBe(bundle.bundleDigest);
  });

  it("preserves file order", () => {
    const files = [makeTextModified("src/a.ts"), makeTextModified("src/b.ts")];
    const bundle = makeBundle(makeBody({ files }));
    const result = buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 1 });

    expect(result.evidenceBundle.body.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("preserves previousCorrections order", () => {
    const previousCorrections = [
      makePreviousCorrection({ reviewNumber: 1 }),
      makePreviousCorrection({ reviewNumber: 2 }),
    ];
    const bundle = makeBundle(makeBody({ previousCorrections }));
    const result = buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 3 });

    expect(result.evidenceBundle.body.previousCorrections.map((correction) => correction.reviewNumber)).toEqual([1, 2]);
  });

  it("calls verifyEvidenceBundle exactly once with the original evidenceBundle", () => {
    const bundle = makeBundle();
    const verifyEvidenceBundleMock = vi.fn().mockReturnValue(bundle);

    buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 1 }, {
      verifyEvidenceBundle: verifyEvidenceBundleMock,
    });

    expect(verifyEvidenceBundleMock).toHaveBeenCalledOnce();
    expect(verifyEvidenceBundleMock).toHaveBeenCalledWith(bundle);
  });

  it("uses the bundle returned by verifyEvidenceBundle", () => {
    const originalBundle = { not: "verified" };
    const verifiedBundle = makeBundle(makeBody({ approvedContract: makeApprovedContract({ objective: "Verified" }) }));
    const verifyEvidenceBundleMock = vi.fn().mockReturnValue(verifiedBundle);

    const result = buildReviewerPromptInput({ evidenceBundle: originalBundle, reviewNumber: 1 }, {
      verifyEvidenceBundle: verifyEvidenceBundleMock,
    });

    expect(result.evidenceBundle).toEqual(verifiedBundle);
  });

  it("preserves EvidenceBundleError", () => {
    const original = new EvidenceBundleError("invalid", { code: "INVALID_EVIDENCE_BUNDLE" });
    const verifyEvidenceBundleMock = vi.fn().mockImplementation(() => {
      throw original;
    });

    try {
      buildReviewerPromptInput({ evidenceBundle: {}, reviewNumber: 1 }, {
        verifyEvidenceBundle: verifyEvidenceBundleMock,
      });
      expect.fail("Expected EvidenceBundleError");
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  it("normalizes an unexpected verifier error as INVALID_INPUT with preserved cause", () => {
    const original = new Error("unexpected verifier failure");
    const verifyEvidenceBundleMock = vi.fn().mockImplementation(() => {
      throw original;
    });

    try {
      buildReviewerPromptInput({ evidenceBundle: {}, reviewNumber: 1 }, {
        verifyEvidenceBundle: verifyEvidenceBundleMock,
      });
      expect.fail("Expected ReviewerPromptInputError");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewerPromptInputError);
      expect((error as ReviewerPromptInputError).name).toBe("ReviewerPromptInputError");
      expect((error as ReviewerPromptInputError).code).toBe("INVALID_INPUT");
      expect((error as ReviewerPromptInputError).cause).toBe(original);
      expect((error as ReviewerPromptInputError).details).toBeUndefined();
    }

    expect(verifyEvidenceBundleMock).toHaveBeenCalledOnce();
    expect(verifyEvidenceBundleMock).toHaveBeenCalledWith({});
  });

  it("accepts correction reviewNumber lower than current", () => {
    const bundle = makeBundle(makeBody({ previousCorrections: [makePreviousCorrection({ reviewNumber: 2 })] }));

    expect(() => buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 3 })).not.toThrow();
  });

  it("rejects correction reviewNumber equal to current", () => {
    const bundle = makeBundle(makeBody({ previousCorrections: [makePreviousCorrection({ reviewNumber: 2 })] }));
    const error = expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 2 }),
      "EVIDENCE_IDENTITY_MISMATCH",
    );

    expect(error.details).toEqual({
      reviewNumber: 2,
      offendingPreviousReviewNumber: 2,
      correctionIndex: 0,
      bundleDigest: bundle.bundleDigest,
    });
  });

  it("rejects correction reviewNumber greater than current", () => {
    const bundle = makeBundle(makeBody({ previousCorrections: [makePreviousCorrection({ reviewNumber: 4 })] }));

    expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 3 }),
      "EVIDENCE_IDENTITY_MISMATCH",
    );
  });

  it("rejects multiple corrections when one is invalid", () => {
    const bundle = makeBundle(makeBody({
      previousCorrections: [
        makePreviousCorrection({ reviewNumber: 1 }),
        makePreviousCorrection({ reviewNumber: 3 }),
      ],
    }));
    const error = expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 3 }),
      "EVIDENCE_IDENTITY_MISMATCH",
    );

    expect(error.details?.["correctionIndex"]).toBe(1);
  });

  it("does not include evidence payloads in identity mismatch details", () => {
    const bundle = makeBundle(makeBody({ previousCorrections: [makePreviousCorrection({ reviewNumber: 1 })] }));
    const error = expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 1 }),
      "EVIDENCE_IDENTITY_MISMATCH",
    );

    expect(Object.keys(error.details ?? {})).toEqual([
      "reviewNumber",
      "offendingPreviousReviewNumber",
      "correctionIndex",
      "bundleDigest",
    ]);
  });

  it("freezes copied details", () => {
    const error = new ReviewerPromptInputError("test", {
      code: "INVALID_INPUT",
      details: { key: "value" },
    });

    expect(() => {
      (error.details as Record<string, unknown>).key = "changed";
    }).toThrow();
  });

  it("sets a stable name and cause", () => {
    const cause = new Error("cause");
    const error = new ReviewerPromptInputError("test", { code: "INVALID_INPUT", cause });

    expect(error.name).toBe("ReviewerPromptInputError");
    expect(error.cause).toBe(cause);
  });

  it("rejects invalid source", () => {
    expectPromptInputError(() => buildReviewerPromptInput(null), "INVALID_INPUT");
  });

  it("rejects invalid reviewNumber", () => {
    expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: makeBundle(), reviewNumber: 0 }),
      "INVALID_INPUT",
    );
  });

  it("rejects source extra fields", () => {
    expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: makeBundle(), reviewNumber: 1, extra: true }),
      "INVALID_INPUT",
    );
  });

  it("does not mutate source", () => {
    const bundle = makeBundle();
    const source = { evidenceBundle: bundle, reviewNumber: 1 };
    const before = structuredClone(source);

    buildReviewerPromptInput(source);

    expect(source).toEqual(before);
  });

  it("does not modify the original bundle", () => {
    const bundle = makeBundle(makeBody({ files: [makeTextModified()] }));
    const before = structuredClone(bundle);

    buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 1 });

    expect(bundle).toEqual(before);
  });

  it("does not reorder arrays", () => {
    const files = [makeTextModified("src/a.ts"), makeTextModified("src/b.ts")];
    const previousCorrections = [
      makePreviousCorrection({ reviewNumber: 1 }),
      makePreviousCorrection({ reviewNumber: 2 }),
    ];
    const bundle = makeBundle(makeBody({ files, previousCorrections }));
    const result = buildReviewerPromptInput({ evidenceBundle: bundle, reviewNumber: 3 });

    expect(result.evidenceBundle.body.files).toEqual(files);
    expect(result.evidenceBundle.body.previousCorrections).toEqual(previousCorrections);
  });

  it("maps invalid output to INVALID_INPUT", () => {
    const validBundle = makeBundle();
    const invalidBundle = {
      ...validBundle,
      bundleDigest: "not-a-digest",
    } as EvidenceBundle;
    const verifyEvidenceBundleMock = vi.fn().mockReturnValue(invalidBundle);

    expectPromptInputError(
      () => buildReviewerPromptInput({ evidenceBundle: {}, reviewNumber: 1 }, {
        verifyEvidenceBundle: verifyEvidenceBundleMock,
      }),
      "INVALID_INPUT",
    );
  });
});
