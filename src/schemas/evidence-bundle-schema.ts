import { z } from "zod";
import { executableTaskContractSchema } from "./supervisor-result-schema.js";
import {
  reviewerFindingSchema,
  reviewerRequiredChangeSchema,
} from "./reviewer-result-schema.js";
import type {
  ReviewerFinding,
  ReviewerRequiredChange,
} from "./reviewer-result-schema.js";
import type {
  ChangedFileStatus,
  GitFileMode,
} from "../services/git-change-detector.js";
import type {
  DeterministicRevisionResult,
  RevisionStatus,
} from "../services/deterministic-revision-result.js";
import type {
  PathValidationResult,
  PathViolation,
  PathViolationCode,
} from "../services/path-validation.js";
import type {
  RequiredCommandResult,
  RequiredCommandsExecutionResult,
} from "../services/required-command-runner.js";
import type { ExecutableTaskContract } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_EVIDENCE_BUNDLE_BYTES = 512 * 1024;
export const MAX_CONTEXTUAL_CONTENT_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;

type MutableDeep<T> = T extends readonly (infer U)[]
  ? MutableDeep<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
    : T;

const nonEmptyTrimmedString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "String must not be empty or whitespace only",
  });

const relativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), { message: "Path no puede ser absoluto" })
  .refine((value) => !value.startsWith("./"), { message: "Path no puede empezar con ./" })
  .refine((value) => !value.includes("\\"), { message: "Path no puede contener backslash" })
  .refine((value) => !value.includes("//"), { message: "Path no puede contener //" })
  .refine((value) => value !== ".", { message: "Path no puede ser ." })
  .refine((value) => {
    const segments = value.split("/");
    return segments.every((segment) => segment !== ".." && segment.length > 0);
  }, { message: "Path no puede contener .. o segmentos vacíos" });

const sha256Hash = z
  .string()
  .length(64, { message: "SHA-256 debe tener exactamente 64 caracteres" })
  .regex(/^[0-9a-f]+$/, { message: "SHA-256 debe ser hexadecimal lowercase" })
  .refine((value) => value !== "0".repeat(64), {
    message: "SHA-256 no puede ser sentinel de ceros",
  });

const gitObjectId = z
  .string()
  .regex(/^[0-9a-f]+$/, { message: "Object ID debe ser hexadecimal lowercase" })
  .refine((value) => value.length === 40 || value.length === 64, {
    message: "Object ID debe tener 40 o 64 caracteres",
  })
  .refine((value) => value !== "0".repeat(value.length), {
    message: "Object ID no puede ser sentinel de ceros",
  });

const byteLength = z.number().int().min(0);
const lineCount = z.number().int().min(0);
const similarityScore = z.number().int().min(0).max(100);

// ---------------------------------------------------------------------------
// Git / domain enums with compile-time parity
// ---------------------------------------------------------------------------

export const gitFileModeSchema = z.enum(["100644", "100755", "120000"]);

type GitFileModeMatch =
  [GitFileMode] extends [z.infer<typeof gitFileModeSchema>]
    ? [z.infer<typeof gitFileModeSchema>] extends [GitFileMode]
      ? true
      : false
    : false;

type _AssertGitFileModeMatch = Assert<GitFileModeMatch>;

const changedFileStatusSchema = z.enum([
  "ADDED",
  "MODIFIED",
  "DELETED",
  "RENAMED",
  "UNTRACKED",
]);

type ChangedFileStatusMatch =
  [ChangedFileStatus] extends [z.infer<typeof changedFileStatusSchema>]
    ? [z.infer<typeof changedFileStatusSchema>] extends [ChangedFileStatus]
      ? true
      : false
    : false;

type _AssertChangedFileStatusMatch = Assert<ChangedFileStatusMatch>;

const revisionStatusSchema = z.enum(["REVIEWING", "REVISION_REQUIRED"]);

type RevisionStatusMatch =
  [RevisionStatus] extends [z.infer<typeof revisionStatusSchema>]
    ? [z.infer<typeof revisionStatusSchema>] extends [RevisionStatus]
      ? true
      : false
    : false;

type _AssertRevisionStatusMatch = Assert<RevisionStatusMatch>;

const pathViolationCodeSchema = z.enum(["NOT_ALLOWED", "FORBIDDEN"]);

type PathViolationCodeMatch =
  [PathViolationCode] extends [z.infer<typeof pathViolationCodeSchema>]
    ? [z.infer<typeof pathViolationCodeSchema>] extends [PathViolationCode]
      ? true
      : false
    : false;

type _AssertPathViolationCodeMatch = Assert<PathViolationCodeMatch>;

const nodeSignalSchema = z.enum([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGBREAK",
  "SIGLOST",
  "SIGINFO",
]);

type NodeSignalMatch =
  [NodeJS.Signals] extends [z.infer<typeof nodeSignalSchema>]
    ? [z.infer<typeof nodeSignalSchema>] extends [NodeJS.Signals]
      ? true
      : false
    : false;

type _AssertNodeSignalMatch = Assert<NodeSignalMatch>;

// ---------------------------------------------------------------------------
// TEXT variants
// ---------------------------------------------------------------------------

const textAddedSchema = z
  .object({
    fileKind: z.literal("TEXT"),
    status: z.literal("ADDED"),
    path: relativePath,
    currentMode: gitFileModeSchema,
    currentContent: z.string(),
    currentHash: sha256Hash,
    currentByteLength: byteLength,
    currentLineCount: lineCount,
  })
  .strict();

const textUntrackedSchema = z
  .object({
    fileKind: z.literal("TEXT"),
    status: z.literal("UNTRACKED"),
    path: relativePath,
    currentMode: gitFileModeSchema,
    currentContent: z.string(),
    currentHash: sha256Hash,
    currentByteLength: byteLength,
    currentLineCount: lineCount,
  })
  .strict();

const textModifiedSchema = z
  .object({
    fileKind: z.literal("TEXT"),
    status: z.literal("MODIFIED"),
    path: relativePath,
    previousMode: gitFileModeSchema,
    currentMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    patch: z.string().min(1),
    currentHash: sha256Hash,
    previousHash: sha256Hash,
    currentByteLength: byteLength,
    previousByteLength: byteLength,
    currentContent: z.string(),
    currentContentTruncated: z.boolean(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hashDiffers = data.currentHash !== data.previousHash;
    const modeDiffers = data.previousMode !== data.currentMode;

    if (!hashDiffers && !modeDiffers) {
      ctx.addIssue({
        code: "custom",
        path: ["currentHash"],
        message: "TEXT MODIFIED: debe existir diferencia de hash, modo o ambos",
      });
    }
  });

const textDeletedSchema = z
  .object({
    fileKind: z.literal("TEXT"),
    status: z.literal("DELETED"),
    path: relativePath,
    previousMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    previousContent: z.string(),
    previousHash: sha256Hash,
    previousByteLength: byteLength,
    previousLineCount: lineCount,
  })
  .strict();

const textRenamedPureSchema = z
  .object({
    fileKind: z.literal("TEXT"),
    status: z.literal("RENAMED"),
    renameKind: z.literal("PURE"),
    path: relativePath,
    previousPath: relativePath,
    previousMode: gitFileModeSchema,
    currentMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    similarityScore: z.literal(100),
    currentHash: sha256Hash,
    previousHash: sha256Hash,
    currentByteLength: byteLength,
    previousByteLength: byteLength,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.currentHash !== data.previousHash) {
      ctx.addIssue({
        code: "custom",
        path: ["currentHash"],
        message: "PURE rename: currentHash debe ser igual a previousHash",
      });
    }

    if (data.currentByteLength !== data.previousByteLength) {
      ctx.addIssue({
        code: "custom",
        path: ["currentByteLength"],
        message: "PURE rename: currentByteLength debe ser igual a previousByteLength",
      });
    }

    if (data.currentMode !== data.previousMode) {
      ctx.addIssue({
        code: "custom",
        path: ["currentMode"],
        message: "PURE rename: currentMode debe ser igual a previousMode",
      });
    }
  });

const textRenamedModifiedSchema = z
  .object({
    fileKind: z.literal("TEXT"),
    status: z.literal("RENAMED"),
    renameKind: z.literal("MODIFIED"),
    path: relativePath,
    previousPath: relativePath,
    previousMode: gitFileModeSchema,
    currentMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    similarityScore: similarityScore,
    patch: z.string().min(1),
    currentHash: sha256Hash,
    previousHash: sha256Hash,
    currentByteLength: byteLength,
    previousByteLength: byteLength,
    currentContent: z.string(),
    currentContentTruncated: z.boolean(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hashDiffers = data.currentHash !== data.previousHash;
    const modeDiffers = data.currentMode !== data.previousMode;

    if (!hashDiffers && !modeDiffers) {
      ctx.addIssue({
        code: "custom",
        path: ["currentHash"],
        message: "MODIFIED rename: debe existir diferencia de hash, modo o ambos",
      });
    }
  });

const textRenamedSchema = z.discriminatedUnion("renameKind", [
  textRenamedPureSchema,
  textRenamedModifiedSchema,
]);

export const textEvidenceFileSchema = z.discriminatedUnion("status", [
  textAddedSchema,
  textUntrackedSchema,
  textModifiedSchema,
  textDeletedSchema,
  textRenamedSchema,
]);

// ---------------------------------------------------------------------------
// BINARY variants
// ---------------------------------------------------------------------------

const binaryAddedSchema = z
  .object({
    fileKind: z.literal("BINARY"),
    status: z.literal("ADDED"),
    path: relativePath,
    currentMode: gitFileModeSchema,
    currentHash: sha256Hash,
    currentByteLength: byteLength,
    reviewabilityLimited: z.literal(true),
  })
  .strict();

const binaryUntrackedSchema = z
  .object({
    fileKind: z.literal("BINARY"),
    status: z.literal("UNTRACKED"),
    path: relativePath,
    currentMode: gitFileModeSchema,
    currentHash: sha256Hash,
    currentByteLength: byteLength,
    reviewabilityLimited: z.literal(true),
  })
  .strict();

const binaryModifiedSchema = z
  .object({
    fileKind: z.literal("BINARY"),
    status: z.literal("MODIFIED"),
    path: relativePath,
    previousMode: gitFileModeSchema,
    currentMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    previousHash: sha256Hash,
    currentHash: sha256Hash,
    previousByteLength: byteLength,
    currentByteLength: byteLength,
    reviewabilityLimited: z.literal(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hashDiffers = data.currentHash !== data.previousHash;
    const modeDiffers = data.currentMode !== data.previousMode;

    if (!hashDiffers && !modeDiffers) {
      ctx.addIssue({
        code: "custom",
        path: ["currentHash"],
        message: "BINARY MODIFIED: debe existir diferencia de hash, modo o ambos",
      });
    }
  });

const binaryDeletedSchema = z
  .object({
    fileKind: z.literal("BINARY"),
    status: z.literal("DELETED"),
    path: relativePath,
    previousMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    previousHash: sha256Hash,
    previousByteLength: byteLength,
    reviewabilityLimited: z.literal(true),
  })
  .strict();

const binaryRenamedPureSchema = z
  .object({
    fileKind: z.literal("BINARY"),
    status: z.literal("RENAMED"),
    renameKind: z.literal("PURE"),
    path: relativePath,
    previousPath: relativePath,
    previousMode: gitFileModeSchema,
    currentMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    similarityScore: z.literal(100),
    previousHash: sha256Hash,
    currentHash: sha256Hash,
    previousByteLength: byteLength,
    currentByteLength: byteLength,
    reviewabilityLimited: z.literal(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.currentHash !== data.previousHash) {
      ctx.addIssue({
        code: "custom",
        path: ["currentHash"],
        message: "PURE rename: currentHash debe ser igual a previousHash",
      });
    }

    if (data.currentByteLength !== data.previousByteLength) {
      ctx.addIssue({
        code: "custom",
        path: ["currentByteLength"],
        message: "PURE rename: currentByteLength debe ser igual a previousByteLength",
      });
    }

    if (data.currentMode !== data.previousMode) {
      ctx.addIssue({
        code: "custom",
        path: ["currentMode"],
        message: "PURE rename: currentMode debe ser igual a previousMode",
      });
    }
  });

const binaryRenamedModifiedSchema = z
  .object({
    fileKind: z.literal("BINARY"),
    status: z.literal("RENAMED"),
    renameKind: z.literal("MODIFIED"),
    path: relativePath,
    previousPath: relativePath,
    previousMode: gitFileModeSchema,
    currentMode: gitFileModeSchema,
    previousObjectId: gitObjectId,
    similarityScore: similarityScore,
    previousHash: sha256Hash,
    currentHash: sha256Hash,
    previousByteLength: byteLength,
    currentByteLength: byteLength,
    reviewabilityLimited: z.literal(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hashDiffers = data.currentHash !== data.previousHash;
    const modeDiffers = data.currentMode !== data.previousMode;

    if (!hashDiffers && !modeDiffers) {
      ctx.addIssue({
        code: "custom",
        path: ["currentHash"],
        message: "MODIFIED rename: debe existir diferencia de hash, modo o ambos",
      });
    }
  });

const binaryRenamedSchema = z.discriminatedUnion("renameKind", [
  binaryRenamedPureSchema,
  binaryRenamedModifiedSchema,
]);

export const binaryEvidenceFileSchema = z.discriminatedUnion("status", [
  binaryAddedSchema,
  binaryUntrackedSchema,
  binaryModifiedSchema,
  binaryDeletedSchema,
  binaryRenamedSchema,
]);

// ---------------------------------------------------------------------------
// SYMLINK variants
// ---------------------------------------------------------------------------

const symlinkAddedSchema = z
  .object({
    fileKind: z.literal("SYMLINK"),
    status: z.literal("ADDED"),
    path: relativePath,
    currentMode: z.literal("120000"),
    currentTarget: z.string(),
    currentTargetHash: sha256Hash,
  })
  .strict();

const symlinkUntrackedSchema = z
  .object({
    fileKind: z.literal("SYMLINK"),
    status: z.literal("UNTRACKED"),
    path: relativePath,
    currentMode: z.literal("120000"),
    currentTarget: z.string(),
    currentTargetHash: sha256Hash,
  })
  .strict();

const symlinkModifiedSchema = z
  .object({
    fileKind: z.literal("SYMLINK"),
    status: z.literal("MODIFIED"),
    path: relativePath,
    previousObjectId: gitObjectId,
    currentTarget: z.string(),
    previousTarget: z.string(),
    currentTargetHash: sha256Hash,
    previousTargetHash: sha256Hash,
  })
  .strict()
  .superRefine((data, ctx) => {
    const targetDiffers = data.currentTarget !== data.previousTarget;
    const hashDiffers = data.currentTargetHash !== data.previousTargetHash;

    if (!targetDiffers && !hashDiffers) {
      ctx.addIssue({
        code: "custom",
        path: ["currentTarget"],
        message: "SYMLINK MODIFIED: debe existir diferencia de target o hash",
      });
    }
  });

const symlinkDeletedSchema = z
  .object({
    fileKind: z.literal("SYMLINK"),
    status: z.literal("DELETED"),
    path: relativePath,
    previousObjectId: gitObjectId,
    previousTarget: z.string(),
    previousTargetHash: sha256Hash,
  })
  .strict();

const symlinkRenamedPureSchema = z
  .object({
    fileKind: z.literal("SYMLINK"),
    status: z.literal("RENAMED"),
    renameKind: z.literal("PURE"),
    path: relativePath,
    previousPath: relativePath,
    previousObjectId: gitObjectId,
    similarityScore: z.literal(100),
    currentTarget: z.string(),
    previousTarget: z.string(),
    currentTargetHash: sha256Hash,
    previousTargetHash: sha256Hash,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.currentTarget !== data.previousTarget) {
      ctx.addIssue({
        code: "custom",
        path: ["currentTarget"],
        message: "PURE rename: currentTarget debe ser igual a previousTarget",
      });
    }

    if (data.currentTargetHash !== data.previousTargetHash) {
      ctx.addIssue({
        code: "custom",
        path: ["currentTargetHash"],
        message: "PURE rename: currentTargetHash debe ser igual a previousTargetHash",
      });
    }
  });

const symlinkRenamedModifiedSchema = z
  .object({
    fileKind: z.literal("SYMLINK"),
    status: z.literal("RENAMED"),
    renameKind: z.literal("MODIFIED"),
    path: relativePath,
    previousPath: relativePath,
    previousObjectId: gitObjectId,
    similarityScore: similarityScore,
    currentTarget: z.string(),
    previousTarget: z.string(),
    currentTargetHash: sha256Hash,
    previousTargetHash: sha256Hash,
  })
  .strict()
  .superRefine((data, ctx) => {
    const targetDiffers = data.currentTarget !== data.previousTarget;
    const hashDiffers = data.currentTargetHash !== data.previousTargetHash;

    if (!targetDiffers && !hashDiffers) {
      ctx.addIssue({
        code: "custom",
        path: ["currentTarget"],
        message: "MODIFIED rename: debe existir diferencia de target o hash",
      });
    }
  });

const symlinkRenamedSchema = z.discriminatedUnion("renameKind", [
  symlinkRenamedPureSchema,
  symlinkRenamedModifiedSchema,
]);

export const symlinkEvidenceFileSchema = z.discriminatedUnion("status", [
  symlinkAddedSchema,
  symlinkUntrackedSchema,
  symlinkModifiedSchema,
  symlinkDeletedSchema,
  symlinkRenamedSchema,
]);

// ---------------------------------------------------------------------------
// EvidenceFile
// ---------------------------------------------------------------------------

export const evidenceFileSchema = z.union([
  textEvidenceFileSchema,
  binaryEvidenceFileSchema,
  symlinkEvidenceFileSchema,
]);

// ---------------------------------------------------------------------------
// PreviousCorrection and canonical previousCorrections
// ---------------------------------------------------------------------------

export const previousCorrectionSchema = z
  .object({
    reviewNumber: z.number().int().min(1),
    verdict: z.literal("REVISION_REQUIRED"),
    summary: nonEmptyTrimmedString,
    findings: z.array(reviewerFindingSchema).min(1),
    requiredChanges: z.array(reviewerRequiredChangeSchema).min(1),
  })
  .strict();

const previousCorrectionsSchema = z
  .array(previousCorrectionSchema)
  .superRefine((data, ctx) => {
    for (let i = 1; i < data.length; i++) {
      const previous = data[i - 1]!.reviewNumber;
      const current = data[i]!.reviewNumber;

      if (current === previous) {
        ctx.addIssue({
          code: "custom",
          path: [i, "reviewNumber"],
          message: "previousCorrections no puede contener reviewNumber duplicados",
        });
      }

      if (current < previous) {
        ctx.addIssue({
          code: "custom",
          path: [i, "reviewNumber"],
          message: "previousCorrections debe estar en orden ascendente estricto",
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Path validation evidence
// ---------------------------------------------------------------------------

const pathViolationSchema = z
  .object({
    path: relativePath,
    status: changedFileStatusSchema,
    code: pathViolationCodeSchema,
    message: z.string(),
    previousPath: relativePath.optional(),
  })
  .strict();

const pathValidationResultSchema = z
  .object({
    passed: z.boolean(),
    violations: z.array(pathViolationSchema),
  })
  .strict();

type PathValidationResultMatch =
  [MutableDeep<PathValidationResult>] extends [z.infer<typeof pathValidationResultSchema>]
    ? [z.infer<typeof pathValidationResultSchema>] extends [MutableDeep<PathValidationResult>]
      ? true
      : false
    : false;

type _AssertPathValidationResultMatch = Assert<PathValidationResultMatch>;

type PathViolationMatch =
  [MutableDeep<PathViolation>] extends [z.infer<typeof pathViolationSchema>]
    ? [z.infer<typeof pathViolationSchema>] extends [MutableDeep<PathViolation>]
      ? true
      : false
    : false;

type _AssertPathViolationMatch = Assert<PathViolationMatch>;

// ---------------------------------------------------------------------------
// Command evidence and commandsResult
// ---------------------------------------------------------------------------

export const commandEvidenceSchema = z
  .object({
    command: nonEmptyTrimmedString,
    exitCode: z.number().int().nullable(),
    signal: nodeSignalSchema.nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    passed: z.boolean(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const expectedPassed = (
      data.exitCode === 0 &&
      data.timedOut === false &&
      data.aborted === false &&
      data.signal === null
    );

    if (data.passed !== expectedPassed) {
      ctx.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed debe coincidir exactamente con la regla real del productor",
      });
    }
  });

const commandsResultSchema = z
  .object({
    results: z.array(commandEvidenceSchema),
    passed: z.boolean(),
    stoppedAtIndex: z.number().int().min(0).nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.results.length === 0) {
      if (!data.passed) {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message: "Sin comandos, passed debe ser true",
        });
      }

      if (data.stoppedAtIndex !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAtIndex"],
          message: "Sin comandos, stoppedAtIndex debe ser null",
        });
      }

      return;
    }

    if (data.passed) {
      if (data.stoppedAtIndex !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAtIndex"],
          message: "Si passed es true, stoppedAtIndex debe ser null",
        });
      }

      for (let i = 0; i < data.results.length; i++) {
        if (!data.results[i]!.passed) {
          ctx.addIssue({
            code: "custom",
            path: ["results", i, "passed"],
            message: "Si passed es true, todos los resultados deben pasar",
          });
        }
      }

      return;
    }

    if (data.stoppedAtIndex === null) {
      ctx.addIssue({
        code: "custom",
        path: ["stoppedAtIndex"],
        message: "Si passed es false, stoppedAtIndex no puede ser null",
      });
      return;
    }

    if (data.stoppedAtIndex >= data.results.length) {
      ctx.addIssue({
        code: "custom",
        path: ["stoppedAtIndex"],
        message: "stoppedAtIndex debe apuntar a un índice válido de results",
      });
      return;
    }

    if (data.results.length !== data.stoppedAtIndex + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["results"],
        message: "results debe detenerse exactamente en el primer fallo",
      });
    }

    for (let i = 0; i < data.stoppedAtIndex; i++) {
      if (!data.results[i]!.passed) {
        ctx.addIssue({
          code: "custom",
          path: ["results", i, "passed"],
          message: "Los resultados previos al stoppedAtIndex deben haber pasado",
        });
      }
    }

    if (data.results[data.stoppedAtIndex]!.passed) {
      ctx.addIssue({
        code: "custom",
        path: ["results", data.stoppedAtIndex, "passed"],
        message: "El resultado señalado por stoppedAtIndex debe ser un fallo",
      });
    }
  });

type CommandEvidenceDomain = Omit<MutableDeep<RequiredCommandResult>, "durationMs">;

type CommandsResultEvidenceDomain = {
  results: CommandEvidenceDomain[];
  passed: MutableDeep<RequiredCommandsExecutionResult>["passed"];
  stoppedAtIndex: MutableDeep<RequiredCommandsExecutionResult>["stoppedAtIndex"];
};

type CommandEvidenceMatch =
  [CommandEvidenceDomain] extends [z.infer<typeof commandEvidenceSchema>]
    ? [z.infer<typeof commandEvidenceSchema>] extends [CommandEvidenceDomain]
      ? true
      : false
    : false;

type _AssertCommandEvidenceMatch = Assert<CommandEvidenceMatch>;

type CommandsResultMatch =
  [CommandsResultEvidenceDomain] extends [z.infer<typeof commandsResultSchema>]
    ? [z.infer<typeof commandsResultSchema>] extends [CommandsResultEvidenceDomain]
      ? true
      : false
    : false;

type _AssertCommandsResultMatch = Assert<CommandsResultMatch>;

// ---------------------------------------------------------------------------
// DeterministicRevisionEvidence
// ---------------------------------------------------------------------------

export const deterministicRevisionEvidenceSchema = z
  .object({
    status: revisionStatusSchema,
    pathValidation: pathValidationResultSchema,
    commandsResult: commandsResultSchema.nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const commandsPassed = data.commandsResult === null || data.commandsResult.passed;
    const expectedStatus: RevisionStatus = data.pathValidation.passed && commandsPassed
      ? "REVIEWING"
      : "REVISION_REQUIRED";

    if (data.status !== expectedStatus) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "status debe coincidir exactamente con la decisión real de isRevisionPassing",
      });
    }
  });

type DeterministicRevisionEvidenceDomain = Pick<
  MutableDeep<DeterministicRevisionResult>,
  "status" | "pathValidation"
> & {
  commandsResult: CommandsResultEvidenceDomain | null;
};

type DeterministicRevisionEvidenceMatch =
  [DeterministicRevisionEvidenceDomain] extends [z.infer<typeof deterministicRevisionEvidenceSchema>]
    ? [z.infer<typeof deterministicRevisionEvidenceSchema>] extends [DeterministicRevisionEvidenceDomain]
      ? true
      : false
    : false;

type _AssertDeterministicRevisionEvidenceMatch = Assert<DeterministicRevisionEvidenceMatch>;

// ---------------------------------------------------------------------------
// ApprovedContractEvidence
// ---------------------------------------------------------------------------

export const approvedContractEvidenceSchema = executableTaskContractSchema
  .pick({
    objective: true,
    context: true,
    acceptanceCriteria: true,
    allowedPaths: true,
    forbiddenPaths: true,
    requiredCommands: true,
    assumptions: true,
    risks: true,
  })
  .strict();

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

type ApprovedContractEvidenceMatch =
  [ApprovedContractEvidenceDomain] extends [z.infer<typeof approvedContractEvidenceSchema>]
    ? [z.infer<typeof approvedContractEvidenceSchema>] extends [ApprovedContractEvidenceDomain]
      ? true
      : false
    : false;

type _AssertApprovedContractEvidenceMatch = Assert<ApprovedContractEvidenceMatch>;

// ---------------------------------------------------------------------------
// EvidenceBundleBody / EvidenceBundle
// ---------------------------------------------------------------------------

export const evidenceBundleBodySchema = z
  .object({
    version: z.literal(1),
    baseCommit: gitObjectId,
    headCommit: gitObjectId,
    workspaceFingerprint: sha256Hash,
    files: z.array(evidenceFileSchema),
    deterministicRevision: deterministicRevisionEvidenceSchema,
    previousCorrections: previousCorrectionsSchema,
    approvedContract: approvedContractEvidenceSchema,
  })
  .strict();

export const evidenceBundleSchema = z
  .object({
    body: evidenceBundleBodySchema,
    bundleDigest: sha256Hash,
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type EvidenceFile = z.infer<typeof evidenceFileSchema>;
export type TextAddedFile = z.infer<typeof textAddedSchema>;
export type TextUntrackedFile = z.infer<typeof textUntrackedSchema>;
export type TextModifiedFile = z.infer<typeof textModifiedSchema>;
export type TextDeletedFile = z.infer<typeof textDeletedSchema>;
export type TextRenamedPureFile = z.infer<typeof textRenamedPureSchema>;
export type TextRenamedModifiedFile = z.infer<typeof textRenamedModifiedSchema>;
export type BinaryAddedFile = z.infer<typeof binaryAddedSchema>;
export type BinaryUntrackedFile = z.infer<typeof binaryUntrackedSchema>;
export type BinaryModifiedFile = z.infer<typeof binaryModifiedSchema>;
export type BinaryDeletedFile = z.infer<typeof binaryDeletedSchema>;
export type BinaryRenamedPureFile = z.infer<typeof binaryRenamedPureSchema>;
export type BinaryRenamedModifiedFile = z.infer<typeof binaryRenamedModifiedSchema>;
export type SymlinkAddedFile = z.infer<typeof symlinkAddedSchema>;
export type SymlinkUntrackedFile = z.infer<typeof symlinkUntrackedSchema>;
export type SymlinkModifiedFile = z.infer<typeof symlinkModifiedSchema>;
export type SymlinkDeletedFile = z.infer<typeof symlinkDeletedSchema>;
export type SymlinkRenamedPureFile = z.infer<typeof symlinkRenamedPureSchema>;
export type SymlinkRenamedModifiedFile = z.infer<typeof symlinkRenamedModifiedSchema>;
export type PreviousCorrection = z.infer<typeof previousCorrectionSchema>;
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export type DeterministicRevisionEvidence = z.infer<typeof deterministicRevisionEvidenceSchema>;
export type ApprovedContractEvidence = z.infer<typeof approvedContractEvidenceSchema>;
export type EvidenceBundleBody = z.infer<typeof evidenceBundleBodySchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type GitFileModeSchema = z.infer<typeof gitFileModeSchema>;

type PreviousCorrectionFindingsMatch =
  [PreviousCorrection["findings"][number]] extends [ReviewerFinding]
    ? [ReviewerFinding] extends [PreviousCorrection["findings"][number]]
      ? true
      : false
    : false;

type _AssertPreviousCorrectionFindingsMatch = Assert<PreviousCorrectionFindingsMatch>;

type PreviousCorrectionRequiredChangesMatch =
  [PreviousCorrection["requiredChanges"][number]] extends [ReviewerRequiredChange]
    ? [ReviewerRequiredChange] extends [PreviousCorrection["requiredChanges"][number]]
      ? true
      : false
    : false;

type _AssertPreviousCorrectionRequiredChangesMatch = Assert<PreviousCorrectionRequiredChangesMatch>;
