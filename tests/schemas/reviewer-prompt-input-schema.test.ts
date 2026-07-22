import { describe, expect, expectTypeOf, it } from "vitest";

import { createEvidenceBundle } from "../../src/services/evidence-bundle-service.js";
import {
  reviewerPromptInputSchema,
  reviewerPromptInputSourceSchema,
} from "../../src/schemas/reviewer-prompt-input-schema.js";
import type {
  ReviewerPromptInput,
  ReviewerPromptInputSource,
} from "../../src/schemas/reviewer-prompt-input-schema.js";
import type {
  ApprovedContractEvidence,
  DeterministicRevisionEvidence,
  EvidenceBundle,
  EvidenceBundleBody,
  EvidenceFile,
  PreviousCorrection,
} from "../../src/schemas/evidence-bundle-schema.js";

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
      code: "F-001",
      severity: "MEDIUM",
      title: "Issue",
      description: "Description",
    }],
    requiredChanges: [{
      code: "FIX-001",
      description: "Fix it",
      acceptanceCriteria: ["Fixed"],
      relatedFindingCodes: ["F-001"],
    }],
    ...overrides,
  };
}

function makeTextModified(): EvidenceFile {
  return {
    fileKind: "TEXT",
    status: "MODIFIED",
    path: "src/existing.ts",
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

function makeBinaryAdded(): EvidenceFile {
  return {
    fileKind: "BINARY",
    status: "ADDED",
    path: "assets/image.bin",
    currentMode: "100644",
    currentHash: H64_B,
    currentByteLength: 512,
    reviewabilityLimited: true,
  };
}

function makeSymlinkRenamedPure(): EvidenceFile {
  return {
    fileKind: "SYMLINK",
    status: "RENAMED",
    renameKind: "PURE",
    path: "links/new",
    previousPath: "links/old",
    previousObjectId: H40,
    similarityScore: 100,
    currentTarget: "../target",
    previousTarget: "../target",
    currentTargetHash: H64_C,
    previousTargetHash: H64_C,
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

describe("reviewerPromptInputSourceSchema", () => {
  it("has the expected inferred type", () => {
    expectTypeOf<ReviewerPromptInputSource>().toEqualTypeOf<{
      evidenceBundle: unknown;
      reviewNumber: number;
    }>();
  });

  it("accepts a valid source", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({
      evidenceBundle: makeBundle(),
      reviewNumber: 1,
    }).success).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({
      evidenceBundle: makeBundle(),
      reviewNumber: 1,
      extra: true,
    }).success).toBe(false);
  });

  it("rejects missing evidenceBundle", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ reviewNumber: 1 }).success).toBe(false);
  });

  it("rejects missing reviewNumber", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ evidenceBundle: makeBundle() }).success).toBe(false);
  });

  it("rejects reviewNumber zero", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ evidenceBundle: makeBundle(), reviewNumber: 0 }).success).toBe(false);
  });

  it("rejects negative reviewNumber", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ evidenceBundle: makeBundle(), reviewNumber: -1 }).success).toBe(false);
  });

  it("rejects decimal reviewNumber", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ evidenceBundle: makeBundle(), reviewNumber: 1.5 }).success).toBe(false);
  });

  it("rejects NaN reviewNumber", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ evidenceBundle: makeBundle(), reviewNumber: Number.NaN }).success).toBe(false);
  });

  it("rejects Infinity reviewNumber", () => {
    expect(reviewerPromptInputSourceSchema.safeParse({ evidenceBundle: makeBundle(), reviewNumber: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});

describe("reviewerPromptInputSchema", () => {
  it("has the expected inferred type", () => {
    expectTypeOf<ReviewerPromptInput>().toEqualTypeOf<{
      version: 1;
      reviewNumber: number;
      evidenceBundle: EvidenceBundle;
    }>();
  });

  it("accepts a valid ReviewerPromptInput", () => {
    expect(reviewerPromptInputSchema.safeParse({
      version: 1,
      reviewNumber: 2,
      evidenceBundle: makeBundle(),
    }).success).toBe(true);
  });

  it("requires version literal 1", () => {
    expect(reviewerPromptInputSchema.safeParse({
      version: 1,
      reviewNumber: 1,
      evidenceBundle: makeBundle(),
    }).success).toBe(true);
  });

  it("rejects a different version", () => {
    expect(reviewerPromptInputSchema.safeParse({
      version: 2,
      reviewNumber: 1,
      evidenceBundle: makeBundle(),
    }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(reviewerPromptInputSchema.safeParse({
      version: 1,
      reviewNumber: 1,
      evidenceBundle: makeBundle(),
      taskId: "task-1",
    }).success).toBe(false);
  });

  it("rejects an invalid EvidenceBundle", () => {
    expect(reviewerPromptInputSchema.safeParse({
      version: 1,
      reviewNumber: 1,
      evidenceBundle: { body: {}, bundleDigest: H64 },
    }).success).toBe(false);
  });

  it("preserves EvidenceFile variants", () => {
    const files = [makeTextModified(), makeBinaryAdded(), makeSymlinkRenamedPure()];
    const bundle = makeBundle(makeBody({ files }));
    const result = reviewerPromptInputSchema.parse({ version: 1, reviewNumber: 2, evidenceBundle: bundle });

    expect(result.evidenceBundle.body.files).toEqual(files);
  });

  it("preserves previousCorrections", () => {
    const previousCorrections = [makePreviousCorrection()];
    const bundle = makeBundle(makeBody({ previousCorrections }));
    const result = reviewerPromptInputSchema.parse({ version: 1, reviewNumber: 2, evidenceBundle: bundle });

    expect(result.evidenceBundle.body.previousCorrections).toEqual(previousCorrections);
  });

  it("preserves approvedContract", () => {
    const approvedContract = makeApprovedContract({ objective: "Different objective" });
    const bundle = makeBundle(makeBody({ approvedContract }));
    const result = reviewerPromptInputSchema.parse({ version: 1, reviewNumber: 1, evidenceBundle: bundle });

    expect(result.evidenceBundle.body.approvedContract).toEqual(approvedContract);
  });

  it("preserves deterministicRevision", () => {
    const deterministicRevision = makeDeterministicRevision({
      status: "REVISION_REQUIRED",
      pathValidation: {
        passed: false,
        violations: [{
          path: "src/outside.ts",
          status: "ADDED",
          code: "NOT_ALLOWED",
          message: "Not allowed",
        }],
      },
    });
    const bundle = makeBundle(makeBody({ deterministicRevision }));
    const result = reviewerPromptInputSchema.parse({ version: 1, reviewNumber: 1, evidenceBundle: bundle });

    expect(result.evidenceBundle.body.deterministicRevision).toEqual(deterministicRevision);
  });
});
