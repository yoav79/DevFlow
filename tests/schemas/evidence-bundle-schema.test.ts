import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_CONTEXTUAL_CONTENT_BYTES,
  MAX_EVIDENCE_BUNDLE_BYTES,
  approvedContractEvidenceSchema,
  binaryEvidenceFileSchema,
  commandEvidenceSchema,
  deterministicRevisionEvidenceSchema,
  evidenceBundleBodySchema,
  evidenceBundleSchema,
  evidenceFileSchema,
  gitFileModeSchema,
  previousCorrectionSchema,
  symlinkEvidenceFileSchema,
  textEvidenceFileSchema,
} from "../../src/schemas/evidence-bundle-schema.js";
import type {
  ApprovedContractEvidence,
  BinaryAddedFile,
  BinaryDeletedFile,
  BinaryModifiedFile,
  BinaryRenamedModifiedFile,
  BinaryRenamedPureFile,
  BinaryUntrackedFile,
  CommandEvidence,
  DeterministicRevisionEvidence,
  EvidenceBundle,
  EvidenceBundleBody,
  EvidenceFile,
  GitFileModeSchema,
  PreviousCorrection,
  SymlinkAddedFile,
  SymlinkDeletedFile,
  SymlinkModifiedFile,
  SymlinkRenamedModifiedFile,
  SymlinkRenamedPureFile,
  SymlinkUntrackedFile,
  TextAddedFile,
  TextDeletedFile,
  TextModifiedFile,
  TextRenamedModifiedFile,
  TextRenamedPureFile,
  TextUntrackedFile,
} from "../../src/schemas/evidence-bundle-schema.js";
import type { GitFileMode } from "../../src/services/git-change-detector.js";
import type { DeterministicRevisionResult } from "../../src/services/deterministic-revision-result.js";
import type { ReviewerFinding, ReviewerRequiredChange } from "../../src/schemas/reviewer-result-schema.js";
import type { RequiredCommandResult } from "../../src/services/required-command-runner.js";
import type { ExecutableTaskContract } from "../../src/types.js";

type MutableDeep<T> = T extends readonly (infer U)[]
  ? MutableDeep<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
    : T;

type CommandEvidenceDomain = Omit<MutableDeep<RequiredCommandResult>, "durationMs">;
type DeterministicRevisionEvidenceDomain = Pick<
  MutableDeep<DeterministicRevisionResult>,
  "status" | "pathValidation" | "commandsResult"
>;
type ApprovedContractEvidenceDomain = Pick<
  MutableDeep<ExecutableTaskContract>,
  | "objective"
  | "context"
  | "acceptanceCriteria"
  | "allowedPaths"
  | "forbiddenPaths"
  | "requiredCommands"
  | "assumptions"
  | "risks"
>;

const H40 = "a".repeat(40);
const H40_B = "b".repeat(40);
const H64 = "a".repeat(64);
const H64_B = "b".repeat(64);
const SIGNAL = "SIGTERM" as const;

function makePathViolation() {
  return {
    path: "src/foo.ts",
    status: "ADDED" as const,
    code: "NOT_ALLOWED" as const,
    message: "not allowed",
  };
}

function makeCommandResult(overrides?: Partial<CommandEvidence>): CommandEvidence {
  return {
    command: "npm run build",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    passed: true,
    ...overrides,
  };
}

function makePreviousCorrection(overrides?: Partial<PreviousCorrection>): PreviousCorrection {
  return {
    reviewNumber: 1,
    verdict: "REVISION_REQUIRED",
    summary: "Issues found",
    findings: [
      {
        code: "F-001",
        severity: "MEDIUM",
        title: "Issue",
        description: "Description",
        filePath: "src/foo.ts",
        lineStart: 1,
        lineEnd: 2,
        evidence: "const x = 1",
      },
    ],
    requiredChanges: [
      {
        code: "FIX-001",
        description: "Fix it",
        acceptanceCriteria: ["Fixed"],
        relatedFindingCodes: ["F-001"],
      },
    ],
    ...overrides,
  };
}

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

function makeCommandsResult(
  overrides?: Partial<DeterministicRevisionEvidence["commandsResult"] & object>,
): NonNullable<DeterministicRevisionEvidence["commandsResult"]> {
  return {
    results: [makeCommandResult()],
    passed: true,
    stoppedAtIndex: null,
    ...overrides,
  };
}

function makeDeterministicRevision(
  overrides?: Partial<DeterministicRevisionEvidence>,
): DeterministicRevisionEvidence {
  return {
    status: "REVIEWING",
    pathValidation: {
      passed: true,
      violations: [],
    },
    commandsResult: makeCommandsResult(),
    ...overrides,
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

function makeBundle(overrides?: Partial<EvidenceBundle>): EvidenceBundle {
  return {
    body: makeBody(),
    bundleDigest: H64,
    ...overrides,
  };
}

const textAdded: TextAddedFile = {
  fileKind: "TEXT",
  status: "ADDED",
  path: "src/new.ts",
  currentMode: "100644",
  currentContent: "export const x = 1;",
  currentHash: H64,
  currentByteLength: 19,
  currentLineCount: 1,
};

const textUntracked: TextUntrackedFile = {
  fileKind: "TEXT",
  status: "UNTRACKED",
  path: "src/untracked.ts",
  currentMode: "100644",
  currentContent: "export const y = 2;",
  currentHash: H64,
  currentByteLength: 19,
  currentLineCount: 1,
};

const textModified: TextModifiedFile = {
  fileKind: "TEXT",
  status: "MODIFIED",
  path: "src/existing.ts",
  previousMode: "100644",
  currentMode: "100755",
  previousObjectId: H40,
  patch: "@@ -1 +1 @@\n-old\n+new",
  currentHash: H64,
  previousHash: H64_B,
  currentByteLength: 20,
  previousByteLength: 15,
  currentContent: "new content",
  currentContentTruncated: false,
};

const textDeleted: TextDeletedFile = {
  fileKind: "TEXT",
  status: "DELETED",
  path: "src/old.ts",
  previousMode: "100644",
  previousObjectId: H40,
  previousContent: "old content",
  previousHash: H64,
  previousByteLength: 11,
  previousLineCount: 1,
};

const textRenamedPure: TextRenamedPureFile = {
  fileKind: "TEXT",
  status: "RENAMED",
  renameKind: "PURE",
  path: "src/new-name.ts",
  previousPath: "src/old-name.ts",
  previousMode: "100644",
  currentMode: "100644",
  previousObjectId: H40,
  similarityScore: 100,
  currentHash: H64,
  previousHash: H64,
  currentByteLength: 100,
  previousByteLength: 100,
};

const textRenamedModified: TextRenamedModifiedFile = {
  fileKind: "TEXT",
  status: "RENAMED",
  renameKind: "MODIFIED",
  path: "src/new-modified.ts",
  previousPath: "src/old-modified.ts",
  previousMode: "100644",
  currentMode: "100755",
  previousObjectId: H40,
  similarityScore: 85,
  patch: "@@ -1 +1 @@\n-old\n+new",
  currentHash: H64,
  previousHash: H64_B,
  currentByteLength: 24,
  previousByteLength: 18,
  currentContent: "new modified content",
  currentContentTruncated: false,
};

const binaryAdded: BinaryAddedFile = {
  fileKind: "BINARY",
  status: "ADDED",
  path: "assets/new.png",
  currentMode: "100644",
  currentHash: H64,
  currentByteLength: 1024,
  reviewabilityLimited: true,
};

const binaryUntracked: BinaryUntrackedFile = {
  fileKind: "BINARY",
  status: "UNTRACKED",
  path: "assets/untracked.png",
  currentMode: "100644",
  currentHash: H64,
  currentByteLength: 2048,
  reviewabilityLimited: true,
};

const binaryModified: BinaryModifiedFile = {
  fileKind: "BINARY",
  status: "MODIFIED",
  path: "assets/existing.png",
  previousMode: "100644",
  currentMode: "100755",
  previousObjectId: H40,
  previousHash: H64_B,
  currentHash: H64,
  previousByteLength: 1000,
  currentByteLength: 1200,
  reviewabilityLimited: true,
};

const binaryDeleted: BinaryDeletedFile = {
  fileKind: "BINARY",
  status: "DELETED",
  path: "assets/old.png",
  previousMode: "100644",
  previousObjectId: H40,
  previousHash: H64,
  previousByteLength: 999,
  reviewabilityLimited: true,
};

const binaryRenamedPure: BinaryRenamedPureFile = {
  fileKind: "BINARY",
  status: "RENAMED",
  renameKind: "PURE",
  path: "assets/new-name.png",
  previousPath: "assets/old-name.png",
  previousMode: "100644",
  currentMode: "100644",
  previousObjectId: H40,
  similarityScore: 100,
  previousHash: H64,
  currentHash: H64,
  previousByteLength: 1024,
  currentByteLength: 1024,
  reviewabilityLimited: true,
};

const binaryRenamedModified: BinaryRenamedModifiedFile = {
  fileKind: "BINARY",
  status: "RENAMED",
  renameKind: "MODIFIED",
  path: "assets/new-modified.png",
  previousPath: "assets/old-modified.png",
  previousMode: "100644",
  currentMode: "100755",
  previousObjectId: H40,
  similarityScore: 70,
  previousHash: H64_B,
  currentHash: H64,
  previousByteLength: 900,
  currentByteLength: 1200,
  reviewabilityLimited: true,
};

const symlinkAdded: SymlinkAddedFile = {
  fileKind: "SYMLINK",
  status: "ADDED",
  path: "link-added",
  currentMode: "120000",
  currentTarget: "target.txt",
  currentTargetHash: H64,
};

const symlinkUntracked: SymlinkUntrackedFile = {
  fileKind: "SYMLINK",
  status: "UNTRACKED",
  path: "link-untracked",
  currentMode: "120000",
  currentTarget: "target.txt",
  currentTargetHash: H64,
};

const symlinkModified: SymlinkModifiedFile = {
  fileKind: "SYMLINK",
  status: "MODIFIED",
  path: "link-modified",
  previousObjectId: H40,
  currentTarget: "new-target.txt",
  previousTarget: "old-target.txt",
  currentTargetHash: H64,
  previousTargetHash: H64_B,
};

const symlinkDeleted: SymlinkDeletedFile = {
  fileKind: "SYMLINK",
  status: "DELETED",
  path: "link-deleted",
  previousObjectId: H40,
  previousTarget: "target.txt",
  previousTargetHash: H64,
};

const symlinkRenamedPure: SymlinkRenamedPureFile = {
  fileKind: "SYMLINK",
  status: "RENAMED",
  renameKind: "PURE",
  path: "link-new",
  previousPath: "link-old",
  previousObjectId: H40,
  similarityScore: 100,
  currentTarget: "target.txt",
  previousTarget: "target.txt",
  currentTargetHash: H64,
  previousTargetHash: H64,
};

const symlinkRenamedModified: SymlinkRenamedModifiedFile = {
  fileKind: "SYMLINK",
  status: "RENAMED",
  renameKind: "MODIFIED",
  path: "link-new-modified",
  previousPath: "link-old-modified",
  previousObjectId: H40,
  similarityScore: 80,
  currentTarget: "new-target.txt",
  previousTarget: "old-target.txt",
  currentTargetHash: H64,
  previousTargetHash: H64_B,
};

const validVariantCases: ReadonlyArray<{
  label: string;
  schema: typeof evidenceFileSchema;
  value: EvidenceFile;
}> = [
  { label: "TEXT + ADDED", schema: evidenceFileSchema, value: textAdded },
  { label: "TEXT + UNTRACKED", schema: evidenceFileSchema, value: textUntracked },
  { label: "TEXT + MODIFIED", schema: evidenceFileSchema, value: textModified },
  { label: "TEXT + DELETED", schema: evidenceFileSchema, value: textDeleted },
  { label: "TEXT + RENAMED + PURE", schema: evidenceFileSchema, value: textRenamedPure },
  { label: "TEXT + RENAMED + MODIFIED", schema: evidenceFileSchema, value: textRenamedModified },
  { label: "BINARY + ADDED", schema: evidenceFileSchema, value: binaryAdded },
  { label: "BINARY + UNTRACKED", schema: evidenceFileSchema, value: binaryUntracked },
  { label: "BINARY + MODIFIED", schema: evidenceFileSchema, value: binaryModified },
  { label: "BINARY + DELETED", schema: evidenceFileSchema, value: binaryDeleted },
  { label: "BINARY + RENAMED + PURE", schema: evidenceFileSchema, value: binaryRenamedPure },
  { label: "BINARY + RENAMED + MODIFIED", schema: evidenceFileSchema, value: binaryRenamedModified },
  { label: "SYMLINK + ADDED", schema: evidenceFileSchema, value: symlinkAdded },
  { label: "SYMLINK + UNTRACKED", schema: evidenceFileSchema, value: symlinkUntracked },
  { label: "SYMLINK + MODIFIED", schema: evidenceFileSchema, value: symlinkModified },
  { label: "SYMLINK + DELETED", schema: evidenceFileSchema, value: symlinkDeleted },
  { label: "SYMLINK + RENAMED + PURE", schema: evidenceFileSchema, value: symlinkRenamedPure },
  { label: "SYMLINK + RENAMED + MODIFIED", schema: evidenceFileSchema, value: symlinkRenamedModified },
];

describe("valid variants", () => {
  for (const testCase of validVariantCases) {
    it(`accepts ${testCase.label}`, () => {
      expect(testCase.schema.safeParse(testCase.value).success).toBe(true);
    });
  }
});

describe("family composition and renamed discrimination", () => {
  it("TEXT family discriminates by status", () => {
    expect(textEvidenceFileSchema.safeParse(textAdded).success).toBe(true);
    expect(textEvidenceFileSchema.safeParse(textModified).success).toBe(true);
  });

  it("BINARY family discriminates by status", () => {
    expect(binaryEvidenceFileSchema.safeParse(binaryAdded).success).toBe(true);
    expect(binaryEvidenceFileSchema.safeParse(binaryModified).success).toBe(true);
  });

  it("SYMLINK family discriminates by status", () => {
    expect(symlinkEvidenceFileSchema.safeParse(symlinkAdded).success).toBe(true);
    expect(symlinkEvidenceFileSchema.safeParse(symlinkModified).success).toBe(true);
  });

  it("TEXT rename discriminates by renameKind", () => {
    expect(textEvidenceFileSchema.safeParse(textRenamedPure).success).toBe(true);
    expect(textEvidenceFileSchema.safeParse(textRenamedModified).success).toBe(true);
    expect(textEvidenceFileSchema.safeParse({ ...textRenamedPure, renameKind: "OTHER" }).success).toBe(false);
  });

  it("BINARY rename discriminates by renameKind", () => {
    expect(binaryEvidenceFileSchema.safeParse(binaryRenamedPure).success).toBe(true);
    expect(binaryEvidenceFileSchema.safeParse(binaryRenamedModified).success).toBe(true);
    expect(binaryEvidenceFileSchema.safeParse({ ...binaryRenamedPure, renameKind: "OTHER" }).success).toBe(false);
  });

  it("SYMLINK rename discriminates by renameKind", () => {
    expect(symlinkEvidenceFileSchema.safeParse(symlinkRenamedPure).success).toBe(true);
    expect(symlinkEvidenceFileSchema.safeParse(symlinkRenamedModified).success).toBe(true);
    expect(symlinkEvidenceFileSchema.safeParse({ ...symlinkRenamedPure, renameKind: "OTHER" }).success).toBe(false);
  });
});

describe("direct negative coverage through evidenceFileSchema", () => {
  it("rejects PURE inconsistent from evidenceFileSchema", () => {
    expect(evidenceFileSchema.safeParse({
      ...textRenamedPure,
      previousHash: H64_B,
    }).success).toBe(false);
  });

  it("rejects MODIFIED identical from evidenceFileSchema", () => {
    expect(evidenceFileSchema.safeParse({
      ...textRenamedModified,
      currentHash: H64,
      previousHash: H64,
      currentMode: "100644",
      previousMode: "100644",
    }).success).toBe(false);
  });

  it("rejects renameKind outside RENAMED", () => {
    expect(evidenceFileSchema.safeParse({
      ...textAdded,
      renameKind: "PURE",
    }).success).toBe(false);
  });

  it("rejects previousPath outside RENAMED", () => {
    expect(evidenceFileSchema.safeParse({
      ...textAdded,
      previousPath: "src/old.ts",
    }).success).toBe(false);
  });

  it("rejects SYMLINK with patch", () => {
    expect(evidenceFileSchema.safeParse({
      ...symlinkAdded,
      patch: "@@ -1 +1 @@",
    }).success).toBe(false);
  });

  it("rejects SYMLINK with currentContent", () => {
    expect(evidenceFileSchema.safeParse({
      ...symlinkAdded,
      currentContent: "plain text",
    }).success).toBe(false);
  });

  it("rejects extra key in finding", () => {
    expect(previousCorrectionSchema.safeParse({
      ...makePreviousCorrection(),
      findings: [{
        ...makePreviousCorrection().findings[0]!,
        extra: "bad",
      }],
    }).success).toBe(false);
  });

  it("rejects extra key in requiredChange", () => {
    expect(previousCorrectionSchema.safeParse({
      ...makePreviousCorrection(),
      requiredChanges: [{
        ...makePreviousCorrection().requiredChanges[0]!,
        extra: "bad",
      }],
    }).success).toBe(false);
  });

  it("rejects extra key in pathValidation.violations", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse({
      ...makeDeterministicRevision({
        status: "REVISION_REQUIRED",
        pathValidation: { passed: false, violations: [{ ...makePathViolation(), extra: true }] },
      }),
    }).success).toBe(false);
  });

  it("rejects extra key in commandsResult", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse({
      ...makeDeterministicRevision(),
      commandsResult: {
        ...makeCommandsResult(),
        extra: 1,
      },
    }).success).toBe(false);
  });
});

describe("path and hash validators", () => {
  it("rejects absolute path", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "/a" }).success).toBe(false);
  });

  it("rejects ./ path", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "./a" }).success).toBe(false);
  });

  it("rejects a/../b", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "a/../b" }).success).toBe(false);
  });

  it("rejects ../a", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "../a" }).success).toBe(false);
  });

  it("rejects a/..", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "a/.." }).success).toBe(false);
  });

  it("rejects backslash path", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "a\\b" }).success).toBe(false);
  });

  it("rejects empty path", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "" }).success).toBe(false);
  });

  it("accepts path with spaces", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "dir with spaces/file.txt" }).success).toBe(true);
  });

  it("accepts path with newline", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "dir\nfile.txt" }).success).toBe(true);
  });

  it("accepts path with tab", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, path: "dir\tfile.txt" }).success).toBe(true);
  });

  it("rejects uppercase hash", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, currentHash: "A".repeat(64) }).success).toBe(false);
  });

  it("rejects short hash", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, currentHash: "a".repeat(63) }).success).toBe(false);
  });

  it("rejects all-zero hash", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, currentHash: "0".repeat(64) }).success).toBe(false);
  });

  it("accepts 40-char object ID", () => {
    expect(evidenceFileSchema.safeParse({ ...textModified, previousObjectId: H40 }).success).toBe(true);
  });

  it("accepts 64-char object ID", () => {
    expect(evidenceFileSchema.safeParse({ ...textModified, previousObjectId: H64 }).success).toBe(true);
  });

  it("rejects abbreviated object ID", () => {
    expect(evidenceFileSchema.safeParse({ ...textModified, previousObjectId: "a".repeat(12) }).success).toBe(false);
  });

  it("rejects all-zero object ID", () => {
    expect(evidenceFileSchema.safeParse({ ...textModified, previousObjectId: "0".repeat(40) }).success).toBe(false);
  });

  it("rejects NaN byteLength", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, currentByteLength: Number.NaN }).success).toBe(false);
  });

  it("rejects Infinity byteLength", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, currentByteLength: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("rejects decimal byteLength", () => {
    expect(evidenceFileSchema.safeParse({ ...textAdded, currentByteLength: 1.5 }).success).toBe(false);
  });
});

describe("workspace fingerprint and bundle/body strictness", () => {
  it("accepts valid workspaceFingerprint SHA-256", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody()).success).toBe(true);
  });

  it("rejects short workspaceFingerprint", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody({ workspaceFingerprint: "fp-abc" })).success).toBe(false);
  });

  it("rejects uppercase workspaceFingerprint", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody({ workspaceFingerprint: "A".repeat(64) })).success).toBe(false);
  });

  it("rejects reviewerClaimJson", () => {
    expect(evidenceBundleBodySchema.safeParse({
      ...makeBody(),
      reviewerClaimJson: "{}",
    }).success).toBe(false);
  });

  it("rejects generatedAt", () => {
    expect(evidenceBundleBodySchema.safeParse({
      ...makeBody(),
      generatedAt: "2026-01-01T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("rejects durationMs", () => {
    expect(evidenceBundleBodySchema.safeParse({
      ...makeBody(),
      durationMs: 100,
    }).success).toBe(false);
  });

  it("rejects repositoryPath", () => {
    expect(evidenceBundleBodySchema.safeParse({
      ...makeBody(),
      repositoryPath: "/repo",
    }).success).toBe(false);
  });

  it("rejects workspacePath", () => {
    expect(evidenceBundleBodySchema.safeParse({
      ...makeBody(),
      workspacePath: "/workspace",
    }).success).toBe(false);
  });

  it("rejects runNumber", () => {
    expect(evidenceBundleBodySchema.safeParse({
      ...makeBody(),
      runNumber: 1,
    }).success).toBe(false);
  });

  it("rejects bundle extra key", () => {
    expect(evidenceBundleSchema.safeParse({ ...makeBundle(), extra: 1 }).success).toBe(false);
  });
});

describe("previousCorrections canonicalization", () => {
  it("accepts empty previousCorrections", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody({ previousCorrections: [] })).success).toBe(true);
  });

  it("accepts ascending previousCorrections", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody({
      previousCorrections: [
        makePreviousCorrection({ reviewNumber: 1 }),
        makePreviousCorrection({ reviewNumber: 2, summary: "Second", findings: [{
          code: "F-002",
          severity: "MEDIUM",
          title: "Issue 2",
          description: "Description 2",
        }], requiredChanges: [{
          code: "FIX-002",
          description: "Fix second",
          acceptanceCriteria: ["Done"],
          relatedFindingCodes: ["F-002"],
        }] }),
      ],
    })).success).toBe(true);
  });

  it("rejects duplicate previousCorrections", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody({
      previousCorrections: [
        makePreviousCorrection({ reviewNumber: 1 }),
        makePreviousCorrection({ reviewNumber: 1, summary: "Duplicate", findings: [{
          code: "F-002",
          severity: "MEDIUM",
          title: "Issue 2",
          description: "Description 2",
        }], requiredChanges: [{
          code: "FIX-002",
          description: "Fix second",
          acceptanceCriteria: ["Done"],
          relatedFindingCodes: ["F-002"],
        }] }),
      ],
    })).success).toBe(false);
  });

  it("rejects descending previousCorrections", () => {
    expect(evidenceBundleBodySchema.safeParse(makeBody({
      previousCorrections: [
        makePreviousCorrection({ reviewNumber: 2 }),
        makePreviousCorrection({ reviewNumber: 1, summary: "Earlier", findings: [{
          code: "F-002",
          severity: "MEDIUM",
          title: "Issue 2",
          description: "Description 2",
        }], requiredChanges: [{
          code: "FIX-002",
          description: "Fix second",
          acceptanceCriteria: ["Done"],
          relatedFindingCodes: ["F-002"],
        }] }),
      ],
    })).success).toBe(false);
  });

  it("rejects APPROVED previousCorrection", () => {
    expect(previousCorrectionSchema.safeParse({
      ...makePreviousCorrection(),
      verdict: "APPROVED",
    }).success).toBe(false);
  });
});

describe("CommandEvidence and commandsResult alignment", () => {
  it("accepts exitCode null for timeout result", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({
      exitCode: null,
      signal: SIGNAL,
      timedOut: true,
      passed: false,
    })).success).toBe(true);
  });

  it("accepts exitCode null for abort result", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({
      exitCode: null,
      signal: null,
      aborted: true,
      passed: false,
    })).success).toBe(true);
  });

  it("rejects passed=true with non-zero exitCode", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({ exitCode: 1, passed: true })).success).toBe(false);
  });

  it("rejects passed=true with exitCode=null", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({ exitCode: null, passed: true })).success).toBe(false);
  });

  it("rejects passed=true with timedOut=true", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({ exitCode: 0, timedOut: true, passed: true })).success).toBe(false);
  });

  it("rejects passed=true with aborted=true", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({ exitCode: 0, aborted: true, passed: true })).success).toBe(false);
  });

  it("rejects passed=true with signal non-null", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({ exitCode: 0, signal: SIGNAL, passed: true })).success).toBe(false);
  });

  it("rejects passed=false when command is actual success", () => {
    expect(commandEvidenceSchema.safeParse(makeCommandResult({ passed: false })).success).toBe(false);
  });

  it("accepts commandsResult with stoppedAtIndex null when all pass", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      commandsResult: makeCommandsResult({
        results: [makeCommandResult(), makeCommandResult({ command: "npm test" })],
        passed: true,
        stoppedAtIndex: null,
      }),
    })).success).toBe(true);
  });

  it("accepts commandsResult empty when there are no commands", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      commandsResult: { results: [], passed: true, stoppedAtIndex: null },
    })).success).toBe(true);
  });

  it("rejects stoppedAtIndex out of results", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      status: "REVISION_REQUIRED",
      commandsResult: {
        results: [makeCommandResult({ exitCode: 1, passed: false })],
        passed: false,
        stoppedAtIndex: 1,
      },
    })).success).toBe(false);
  });

  it("rejects passed=true with non-null stoppedAtIndex", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      commandsResult: makeCommandsResult({ stoppedAtIndex: 0 }),
    })).success).toBe(false);
  });
});

describe("DeterministicRevisionEvidence alignment", () => {
  it("accepts commandsResult null", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      commandsResult: null,
    })).success).toBe(true);
  });

  it("rejects REVIEWING with pathValidation.passed=false", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      status: "REVIEWING",
      pathValidation: { passed: false, violations: [makePathViolation()] },
      commandsResult: null,
    })).success).toBe(false);
  });

  it("rejects REVIEWING with commandsResult.passed=false", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      status: "REVIEWING",
      commandsResult: {
        results: [makeCommandResult({ exitCode: 1, passed: false })],
        passed: false,
        stoppedAtIndex: 0,
      },
    })).success).toBe(false);
  });

  it("rejects REVISION_REQUIRED when paths and commands fully pass", () => {
    expect(deterministicRevisionEvidenceSchema.safeParse(makeDeterministicRevision({
      status: "REVISION_REQUIRED",
      pathValidation: { passed: true, violations: [] },
      commandsResult: makeCommandsResult(),
    })).success).toBe(false);
  });
});

describe("ApprovedContractEvidence", () => {
  it("accepts valid subset", () => {
    expect(approvedContractEvidenceSchema.safeParse(makeApprovedContract()).success).toBe(true);
  });

  it("rejects extra key", () => {
    expect(approvedContractEvidenceSchema.safeParse({
      ...makeApprovedContract(),
      extra: 1,
    }).success).toBe(false);
  });
});

describe("module surface and constants", () => {
  it("exports runtime surface", async () => {
    const mod = await import("../../src/schemas/evidence-bundle-schema.js");
    expect(mod.evidenceBundleSchema).toBeDefined();
    expect(mod.evidenceBundleBodySchema).toBeDefined();
    expect(mod.evidenceFileSchema).toBeDefined();
    expect(mod.textEvidenceFileSchema).toBeDefined();
    expect(mod.binaryEvidenceFileSchema).toBeDefined();
    expect(mod.symlinkEvidenceFileSchema).toBeDefined();
    expect(mod.previousCorrectionSchema).toBeDefined();
    expect(mod.commandEvidenceSchema).toBeDefined();
    expect(mod.deterministicRevisionEvidenceSchema).toBeDefined();
    expect(mod.approvedContractEvidenceSchema).toBeDefined();
    expect(mod.gitFileModeSchema).toBeDefined();
  });

  it("exports exact limits", () => {
    expect(MAX_EVIDENCE_BUNDLE_BYTES).toBe(512 * 1024);
    expect(MAX_CONTEXTUAL_CONTENT_BYTES).toBe(128 * 1024);
  });
});

describe("GitFileMode runtime schema", () => {
  it("accepts exactly the published modes", () => {
    expect(gitFileModeSchema.safeParse("100644").success).toBe(true);
    expect(gitFileModeSchema.safeParse("100755").success).toBe(true);
    expect(gitFileModeSchema.safeParse("120000").success).toBe(true);
    expect(gitFileModeSchema.safeParse("160000").success).toBe(false);
  });
});

describe("no mutation", () => {
  it("does not mutate previousCorrections array", () => {
    const previousCorrections = [makePreviousCorrection({ reviewNumber: 1 })];
    const snapshot = JSON.stringify(previousCorrections);
    evidenceBundleBodySchema.safeParse(makeBody({ previousCorrections }));
    expect(JSON.stringify(previousCorrections)).toBe(snapshot);
  });

  it("does not mutate arrays during parse", () => {
    const input = makeBundle({
      body: makeBody({
        files: [textAdded],
        previousCorrections: [makePreviousCorrection()],
      }),
    });
    const snapshot = JSON.stringify(input);
    evidenceBundleSchema.safeParse(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("compile-time compatibility", () => {
  it("matches published domain types", () => {
    expectTypeOf<GitFileModeSchema>().toEqualTypeOf<GitFileMode>();
    expectTypeOf<GitFileMode>().toEqualTypeOf<GitFileModeSchema>();

    expectTypeOf<PreviousCorrection["findings"][number]>().toEqualTypeOf<ReviewerFinding>();
    expectTypeOf<PreviousCorrection["requiredChanges"][number]>().toEqualTypeOf<ReviewerRequiredChange>();

    expectTypeOf<ApprovedContractEvidence>().toEqualTypeOf<ApprovedContractEvidenceDomain>();
    expectTypeOf<ApprovedContractEvidenceDomain>().toEqualTypeOf<ApprovedContractEvidence>();

    expectTypeOf<CommandEvidence>().toEqualTypeOf<CommandEvidenceDomain>();
    expectTypeOf<CommandEvidenceDomain>().toEqualTypeOf<CommandEvidence>();

    expectTypeOf<DeterministicRevisionEvidence>().toEqualTypeOf<DeterministicRevisionEvidenceDomain>();
    expectTypeOf<DeterministicRevisionEvidenceDomain>().toEqualTypeOf<DeterministicRevisionEvidence>();
  });
});
