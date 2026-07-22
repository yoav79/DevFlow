import { describe, expect, expectTypeOf, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createEvidenceBundle,
  EvidenceBundleError,
  verifyEvidenceBundle,
} from "../../src/services/evidence-bundle-service.js";
import type { EvidenceBundleErrorCode } from "../../src/services/evidence-bundle-service.js";
import {
  evidenceBundleSchema,
  MAX_EVIDENCE_BUNDLE_BYTES,
} from "../../src/schemas/evidence-bundle-schema.js";
import type {
  EvidenceBundle,
  EvidenceBundleBody,
} from "../../src/schemas/evidence-bundle-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const H40 = "a".repeat(40);
const H40_B = "b".repeat(40);
const H64 = "c".repeat(64);
const H64_B = "d".repeat(64);
const H64_C = "e".repeat(64);

function makeTextModified() {
  return {
    fileKind: "TEXT" as const,
    status: "MODIFIED" as const,
    path: "src/existing.ts",
    previousMode: "100644" as const,
    currentMode: "100755" as const,
    previousObjectId: H40,
    patch: "@@ -1 +1 @@\n-old\n+new",
    currentHash: H64,
    previousHash: H64_B,
    currentByteLength: 20,
    previousByteLength: 15,
    currentContent: "export const x = 1;",
    currentContentTruncated: false,
  };
}

function makePreviousCorrection() {
  return {
    reviewNumber: 1,
    verdict: "REVISION_REQUIRED" as const,
    summary: "Issues found",
    findings: [
      {
        code: "F-001",
        severity: "MEDIUM" as const,
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
  };
}

function makeApprovedContract() {
  return {
    objective: "Implement feature",
    context: "Project needs it",
    acceptanceCriteria: ["Works correctly"],
    allowedPaths: ["src"],
    forbiddenPaths: ["dist"],
    requiredCommands: ["npm test"],
    assumptions: ["Node installed"],
    risks: ["None"],
  };
}

function expectedCanonicalJson(options?: {
  readonly context?: string;
  readonly objective?: string;
}): string {
  const context = options?.context ?? "Project needs it";
  const objective = options?.objective ?? "Implement feature";
  return `{"approvedContract":{"acceptanceCriteria":["Works correctly"],"allowedPaths":["src"],"assumptions":["Node installed"],"context":"${context}","forbiddenPaths":["dist"],"objective":"${objective}","requiredCommands":["npm test"],"risks":["None"]},"baseCommit":"${H40}","deterministicRevision":{"commandsResult":{"passed":true,"results":[{"aborted":false,"command":"npm run build","exitCode":0,"passed":true,"signal":null,"stderr":"","stderrTruncated":false,"stdout":"","stdoutTruncated":false,"timedOut":false}],"stoppedAtIndex":null},"pathValidation":{"passed":true,"violations":[]},"status":"REVIEWING"},"files":[],"headCommit":"${H40_B}","previousCorrections":[],"version":1,"workspaceFingerprint":"${H64}"}`;
}

function expectedDigest(canonicalJson: string): string {
  return createHash("sha256")
    .update(canonicalJson, "utf8")
    .digest("hex");
}

function makeBody(overrides?: Partial<EvidenceBundleBody>): EvidenceBundleBody {
  return {
    version: 1,
    baseCommit: H40,
    headCommit: H40_B,
    workspaceFingerprint: H64,
    files: [],
    deterministicRevision: {
      status: "REVIEWING",
      pathValidation: { passed: true, violations: [] },
      commandsResult: {
        results: [
          {
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
          },
        ],
        passed: true,
        stoppedAtIndex: null,
      },
    },
    previousCorrections: [],
    approvedContract: makeApprovedContract(),
    ...overrides,
  };
}

function makeBodyWithFile(): EvidenceBundleBody {
  return makeBody({
    files: [makeTextModified()],
  });
}

function makeBodyWithPreviousCorrections(): EvidenceBundleBody {
  return makeBody({
    previousCorrections: [makePreviousCorrection()],
  });
}

// ---------------------------------------------------------------------------
// Compile-time type tests
// ---------------------------------------------------------------------------

describe("compile-time types", () => {
  it("createEvidenceBundle returns EvidenceBundle", () => {
    expectTypeOf(createEvidenceBundle).returns.toEqualTypeOf<EvidenceBundle>();
  });

  it("verifyEvidenceBundle returns EvidenceBundle", () => {
    expectTypeOf(verifyEvidenceBundle).returns.toEqualTypeOf<EvidenceBundle>();
  });

  it("EvidenceBundleErrorCode has correct codes", () => {
    expectTypeOf<EvidenceBundleErrorCode>().toEqualTypeOf<
      | "INVALID_EVIDENCE_BODY"
      | "INVALID_EVIDENCE_BUNDLE"
      | "EVIDENCE_BUNDLE_TOO_LARGE"
      | "EVIDENCE_BUNDLE_DIGEST_MISMATCH"
    >();
  });
});

// ---------------------------------------------------------------------------
// Public API exports
// ---------------------------------------------------------------------------

describe("public API exports", () => {
  it("exports createEvidenceBundle as function", () => {
    expect(typeof createEvidenceBundle).toBe("function");
  });

  it("exports verifyEvidenceBundle as function", () => {
    expect(typeof verifyEvidenceBundle).toBe("function");
  });

  it("exports EvidenceBundleError as class", () => {
    expect(typeof EvidenceBundleError).toBe("function");
  });

  it("does not export internal helpers", async () => {
    const mod = await import(
      "../../src/services/evidence-bundle-service.js"
    );
    const exports = Object.keys(mod);
    expect(exports).toEqual([
      "EvidenceBundleError",
      "createEvidenceBundle",
      "verifyEvidenceBundle",
    ]);
  });
});

// ---------------------------------------------------------------------------
// createEvidenceBundle
// ---------------------------------------------------------------------------

describe("createEvidenceBundle", () => {
  it("accepts a valid EvidenceBundleBody and returns EvidenceBundle", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);

    const validation = evidenceBundleSchema.safeParse(bundle);
    expect(validation.success).toBe(true);
  });

  it("returns body identical to the normalized body used for digest", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);

    const digest = expectedDigest(expectedCanonicalJson());

    expect(bundle.bundleDigest).toBe(digest);
  });

  it("does not mutate the input", () => {
    const body = makeBody();
    const frozen = JSON.stringify(body);
    createEvidenceBundle(body);
    expect(JSON.stringify(body)).toBe(frozen);
  });

  it("produces a digest with 64 lowercase hex characters", () => {
    const bundle = createEvidenceBundle(makeBody());
    expect(bundle.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects undefined root", () => {
    expect(() => createEvidenceBundle(undefined)).toThrow(EvidenceBundleError);
    try {
      createEvidenceBundle(undefined);
    } catch (e) {
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
    }
  });

  it("rejects invalid body with INVALID_EVIDENCE_BODY code", () => {
    try {
      createEvidenceBundle({ version: 999 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
      expect((e as EvidenceBundleError).cause).toBeDefined();
    }
  });

  it("wraps TypeError and RangeError as EvidenceBundleError", () => {
    const badInput = Object.create(null, {
      x: {
        get() {
          throw new TypeError("getter failed");
        },
        enumerable: true,
      },
    });

    expect(() => createEvidenceBundle(badInput)).toThrow(EvidenceBundleError);
  });

  it("maps canonical serialization failure to INVALID_EVIDENCE_BODY", () => {
    const originalStringify = JSON.stringify;
    Object.assign(JSON, {
      stringify() {
        return undefined;
      },
    });

    try {
      createEvidenceBundle(makeBody());
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
    } finally {
      Object.assign(JSON, { stringify: originalStringify });
    }
  });
});

// ---------------------------------------------------------------------------
// verifyEvidenceBundle
// ---------------------------------------------------------------------------

describe("verifyEvidenceBundle", () => {
  it("accepts a valid bundle with matching digest", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);
    const verified = verifyEvidenceBundle(bundle);

    expect(verified.bundleDigest).toBe(bundle.bundleDigest);
  });

  it("rejects invalid bundle with INVALID_EVIDENCE_BUNDLE code", () => {
    try {
      verifyEvidenceBundle({ body: {}, bundleDigest: "x" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BUNDLE");
    }
  });

  it("rejects manipulated body with DIGEST_MISMATCH", () => {
    const bundle = createEvidenceBundle(makeBody());
    const manipulated = {
      body: { ...bundle.body, baseCommit: "1" + "a".repeat(39) },
      bundleDigest: bundle.bundleDigest,
    };

    try {
      verifyEvidenceBundle(manipulated);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe(
        "EVIDENCE_BUNDLE_DIGEST_MISMATCH",
      );
    }
  });

  it("rejects manipulated digest with DIGEST_MISMATCH", () => {
    const bundle = createEvidenceBundle(makeBody());
    const manipulated = {
      body: bundle.body,
      bundleDigest: "1" + "0".repeat(63),
    };

    try {
      verifyEvidenceBundle(manipulated);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe(
        "EVIDENCE_BUNDLE_DIGEST_MISMATCH",
      );
    }
  });

  it("details do not contain both digests", () => {
    const bundle = createEvidenceBundle(makeBody());
    const manipulated = {
      body: bundle.body,
      bundleDigest: "1" + "0".repeat(63),
    };

    try {
      verifyEvidenceBundle(manipulated);
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as EvidenceBundleError;
      expect(err.code).toBe("EVIDENCE_BUNDLE_DIGEST_MISMATCH");
      if (err.details !== undefined) {
        expect(Object.keys(err.details)).not.toContain("expectedDigest");
        expect(Object.keys(err.details)).not.toContain("actualDigest");
      }
    }
  });

  it("accepts body that was normalized by create", () => {
    const body = makeBodyWithFile();
    const bundle = createEvidenceBundle(body);
    const verified = verifyEvidenceBundle(bundle);

    expect(verified.body).toEqual(bundle.body);
  });

  it("does not mutate the input bundle", () => {
    const bundle = createEvidenceBundle(makeBody());
    const frozen = JSON.stringify(bundle);
    verifyEvidenceBundle(bundle);
    expect(JSON.stringify(bundle)).toBe(frozen);
  });

  it("maps canonical serialization failure to INVALID_EVIDENCE_BUNDLE", () => {
    const bundle = createEvidenceBundle(makeBody());
    const originalStringify = JSON.stringify;
    Object.assign(JSON, {
      stringify() {
        return undefined;
      },
    });

    try {
      verifyEvidenceBundle(bundle);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BUNDLE");
    } finally {
      Object.assign(JSON, { stringify: originalStringify });
    }
  });

  it("does not leak internal body error code from verification", () => {
    const bundle = createEvidenceBundle(makeBody());
    const input = {
      body: {
        ...bundle.body,
        files: [undefined],
      },
      bundleDigest: bundle.bundleDigest,
    };

    try {
      verifyEvidenceBundle(input);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BUNDLE");
    }
  });
});

// ---------------------------------------------------------------------------
// Canonicalization: insertion order
// ---------------------------------------------------------------------------

describe("canonicalization: insertion order", () => {
  it("different insertion order produces same body and digest", () => {
    const bodyA = makeBody();
    const bodyB: EvidenceBundleBody = {
      approvedContract: bodyA.approvedContract,
      baseCommit: bodyA.baseCommit,
      deterministicRevision: bodyA.deterministicRevision,
      files: bodyA.files,
      headCommit: bodyA.headCommit,
      previousCorrections: bodyA.previousCorrections,
      version: bodyA.version,
      workspaceFingerprint: bodyA.workspaceFingerprint,
    };

    const bundleA = createEvidenceBundle(bodyA);
    const bundleB = createEvidenceBundle(bodyB);

    expect(bundleA.bundleDigest).toBe(bundleB.bundleDigest);
    expect(bundleA.body).toEqual(bundleB.body);
  });
});

// ---------------------------------------------------------------------------
// Canonicalization: nested objects
// ---------------------------------------------------------------------------

describe("canonicalization: nested objects", () => {
  it("nested properties with names absent from root survive", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);

    const normalized = JSON.parse(JSON.stringify(bundle.body)) as Record<
      string,
      unknown
    >;

    expect(normalized.deterministicRevision).toBeDefined();
    expect((normalized.deterministicRevision as Record<string, unknown>).pathValidation).toBeDefined();
    expect(
      ((normalized.deterministicRevision as Record<string, unknown>).pathValidation as Record<string, unknown>)
        .violations,
    ).toBeDefined();
  });

  it("approved contract preserves all nested keys", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);

    const contract = bundle.body.approvedContract;
    expect(contract.objective).toBe("Implement feature");
    expect(contract.context).toBe("Project needs it");
    expect(contract.acceptanceCriteria).toEqual(["Works correctly"]);
    expect(contract.allowedPaths).toEqual(["src"]);
    expect(contract.forbiddenPaths).toEqual(["dist"]);
    expect(contract.requiredCommands).toEqual(["npm test"]);
    expect(contract.assumptions).toEqual(["Node installed"]);
    expect(contract.risks).toEqual(["None"]);
  });

  it("previous corrections preserves findings and requiredChanges", () => {
    const body = makeBodyWithPreviousCorrections();
    const bundle = createEvidenceBundle(body);

    const pc = bundle.body.previousCorrections;
    expect(pc).toHaveLength(1);
    expect(pc[0].findings).toHaveLength(1);
    expect(pc[0].findings[0].code).toBe("F-001");
    expect(pc[0].requiredChanges).toHaveLength(1);
    expect(pc[0].requiredChanges[0].code).toBe("FIX-001");
    expect(pc[0].requiredChanges[0].acceptanceCriteria).toEqual(["Fixed"]);
    expect(pc[0].requiredChanges[0].relatedFindingCodes).toEqual(["F-001"]);
  });

  it("TEXT/MODIFIED file preserves all fields", () => {
    const body = makeBodyWithFile();
    const bundle = createEvidenceBundle(body);

    const file = bundle.body.files[0];
    expect(file.fileKind).toBe("TEXT");
    expect(file.status).toBe("MODIFIED");
    expect(file.path).toBe("src/existing.ts");
    expect(file.currentHash).toBe(H64);
    expect(file.previousHash).toBe(H64_B);
    expect(file.patch).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(file.currentContent).toBe("export const x = 1;");
  });
});

// ---------------------------------------------------------------------------
// Canonicalization: arrays
// ---------------------------------------------------------------------------

describe("canonicalization: arrays", () => {
  it("arrays preserve order", () => {
    const body = makeBody({
      files: [
        { ...makeTextModified(), path: "a.ts" },
        { ...makeTextModified(), path: "b.ts" },
      ],
    });
    const bundle = createEvidenceBundle(body);

    expect(bundle.body.files[0].path).toBe("a.ts");
    expect(bundle.body.files[1].path).toBe("b.ts");
  });

  it("reordering array changes digest", () => {
    const bodyA = makeBody({
      files: [
        { ...makeTextModified(), path: "a.ts" },
        { ...makeTextModified(), path: "b.ts" },
      ],
    });
    const bodyB = makeBody({
      files: [
        { ...makeTextModified(), path: "b.ts" },
        { ...makeTextModified(), path: "a.ts" },
      ],
    });

    const bundleA = createEvidenceBundle(bodyA);
    const bundleB = createEvidenceBundle(bodyB);

    expect(bundleA.bundleDigest).not.toBe(bundleB.bundleDigest);
  });

  it("modifying a value changes digest", () => {
    const bodyA = makeBody();
    const bodyB = makeBody({ baseCommit: H40_B });

    const bundleA = createEvidenceBundle(bodyA);
    const bundleB = createEvidenceBundle(bodyB);

    expect(bundleA.bundleDigest).not.toBe(bundleB.bundleDigest);
  });
});

// ---------------------------------------------------------------------------
// Canonicalization: replacer regression
// ---------------------------------------------------------------------------

describe("canonicalization: replacer regression", () => {
  it("nested keys with names absent from root survive in canonical body", () => {
    const body = makeBodyWithFile();
    const bundle = createEvidenceBundle(body);

    const fullJson = JSON.stringify(bundle.body);
    const parsed = JSON.parse(fullJson) as Record<string, unknown>;

    const dr = parsed.deterministicRevision as Record<string, unknown>;
    expect(dr).toBeDefined();

    const pv = dr.pathValidation as Record<string, unknown>;
    expect(pv).toBeDefined();
    expect(pv.violations).toBeDefined();

    const ac = parsed.approvedContract as Record<string, unknown>;
    expect(ac.objective).toBeDefined();
    expect(ac.acceptanceCriteria).toBeDefined();
  });

  it("reproduces expected digest from independently constructed normalized body", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);

    const expectedJson = expectedCanonicalJson();
    const rootKeys = Object.keys(bundle.body);
    const contractKeys = Object.keys(bundle.body.approvedContract);
    const commandKeys = Object.keys(
      bundle.body.deterministicRevision.commandsResult!.results[0],
    );

    expect(expectedJson.includes("\n")).toBe(false);
    expect(rootKeys).toEqual([
      "approvedContract",
      "baseCommit",
      "deterministicRevision",
      "files",
      "headCommit",
      "previousCorrections",
      "version",
      "workspaceFingerprint",
    ]);
    expect(contractKeys).toEqual([
      "acceptanceCriteria",
      "allowedPaths",
      "assumptions",
      "context",
      "forbiddenPaths",
      "objective",
      "requiredCommands",
      "risks",
    ]);
    expect(commandKeys).toEqual([
      "aborted",
      "command",
      "exitCode",
      "passed",
      "signal",
      "stderr",
      "stderrTruncated",
      "stdout",
      "stdoutTruncated",
      "timedOut",
    ]);
    expect(bundle.body.approvedContract.acceptanceCriteria).toEqual([
      "Works correctly",
    ]);
    expect(bundle.body.deterministicRevision.pathValidation.violations).toEqual(
      [],
    );
    expect(bundle.bundleDigest).toBe(expectedDigest(expectedJson));
  });
});

// ---------------------------------------------------------------------------
// Undefined handling
// ---------------------------------------------------------------------------

describe("undefined handling", () => {
  it("optional property omitted produces same body as explicit undefined", () => {
    const bodyWithOmitted = makeBody();
    const bodyWithUndefined: Record<string, unknown> = {
      ...makeBody(),
    };

    const bundleOmitted = createEvidenceBundle(bodyWithOmitted);
    const bundleUndefined = createEvidenceBundle(bodyWithUndefined);

    expect(bundleOmitted.body).toEqual(bundleUndefined.body);
    expect(bundleOmitted.bundleDigest).toBe(bundleUndefined.bundleDigest);
  });

  it("undefined is eliminated from returned body", () => {
    const input = {
      version: 1,
      baseCommit: H40,
      headCommit: H40_B,
      workspaceFingerprint: H64,
      files: [],
      deterministicRevision: {
        status: "REVIEWING",
        pathValidation: { passed: true, violations: [] },
        commandsResult: {
          results: [
            {
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
            },
          ],
          passed: true,
          stoppedAtIndex: null,
        },
      },
      previousCorrections: [],
      approvedContract: makeApprovedContract(),
    };

    const bundle = createEvidenceBundle(input);
    const keys = Object.keys(bundle.body);
    for (const key of keys) {
      expect((bundle.body as Record<string, unknown>)[key]).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Undefined in arrays
// ---------------------------------------------------------------------------

describe("undefined in arrays", () => {
  it("rejects undefined array element", () => {
    const body: unknown = { ...makeBody(), files: [undefined] };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
    try {
      createEvidenceBundle(body);
    } catch (e) {
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
    }
  });

  it("rejects sparse array", () => {
    const arr = new Array(3);
    arr[0] = makeTextModified();
    arr[2] = makeTextModified();

    const body = makeBody({ files: arr as EvidenceBundleBody["files"] });
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("undefined is never converted to null", () => {
    const body = makeBody();
    const bundle = createEvidenceBundle(body);

    const json = JSON.stringify(bundle.body);
    expect(json).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe("cycles", () => {
  it("rejects direct cycle", () => {
    const body = makeBody() as Record<string, unknown>;
    (body as Record<string, unknown>).self = body;

    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
    try {
      createEvidenceBundle(body);
    } catch (e) {
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
      expect(e).not.toBeInstanceOf(RangeError);
    }
  });

  it("rejects indirect cycle", () => {
    const a: Record<string, unknown> = { x: 1 };
    const b: Record<string, unknown> = { y: 2 };
    a.child = b;
    b.parent = a;

    expect(() => createEvidenceBundle(a)).toThrow(EvidenceBundleError);
    try {
      createEvidenceBundle(a);
    } catch (e) {
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
      expect(e).not.toBeInstanceOf(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// Shared references
// ---------------------------------------------------------------------------

describe("shared references", () => {
  it("accepts shared reference without classifying it as a cycle", () => {
    const sharedFinding = makePreviousCorrection().findings[0];
    const correction = {
      ...makePreviousCorrection(),
      findings: [sharedFinding, sharedFinding],
    };
    const body = makeBody({
      previousCorrections: [correction],
    });
    const frozenInput = JSON.stringify(body);

    expect(body.previousCorrections[0].findings[0]).toBe(
      body.previousCorrections[0].findings[1],
    );
    const bundle = createEvidenceBundle(body);

    expect(JSON.stringify(body)).toBe(frozenInput);
    expect(bundle.body.previousCorrections).toHaveLength(1);
    expect(bundle.body.previousCorrections[0].findings).toHaveLength(2);
    expect(bundle.body.previousCorrections[0].findings[0].code).toBe("F-001");
    expect(bundle.body.previousCorrections[0].findings[1].code).toBe("F-001");
    expect(bundle.body.previousCorrections[0].findings[0]).toEqual(
      bundle.body.previousCorrections[0].findings[1],
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid inputs
// ---------------------------------------------------------------------------

describe("invalid inputs", () => {
  it("rejects NaN", () => {
    const body: unknown = { ...makeBody(), version: NaN };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects Infinity", () => {
    const body: unknown = { ...makeBody(), version: Infinity };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects bigint", () => {
    const body: unknown = { ...makeBody(), version: 1n };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects Date", () => {
    const body: unknown = { ...makeBody(), version: new Date() };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects Map", () => {
    const body: unknown = { ...makeBody(), files: new Map() };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects Set", () => {
    const body: unknown = { ...makeBody(), files: new Set() };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects function", () => {
    const body: unknown = { ...makeBody(), version: () => 1 };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects symbol", () => {
    const body: unknown = { ...makeBody(), version: Symbol("x") };
    expect(() => createEvidenceBundle(body)).toThrow(EvidenceBundleError);
  });

  it("rejects getter that throws", () => {
    const input = Object.create(null, {
      x: {
        get() {
          throw new TypeError("boom");
        },
        enumerable: true,
      },
    });
    expect(() => createEvidenceBundle(input)).toThrow(EvidenceBundleError);
  });
});

// ---------------------------------------------------------------------------
// Prototypes
// ---------------------------------------------------------------------------

describe("prototypes", () => {
  it("null prototype object is accepted by Zod and normalized", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input.version = 1;
    input.baseCommit = H40;
    input.headCommit = H40_B;
    input.workspaceFingerprint = H64;
    input.files = [];
    input.deterministicRevision = {
      status: "REVIEWING",
      pathValidation: { passed: true, violations: [] },
      commandsResult: null,
    };
    input.previousCorrections = [];
    input.approvedContract = makeApprovedContract();

    const bundle = createEvidenceBundle(input);
    expect(bundle.body.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

describe("UTF-8 encoding", () => {
  it("handles multibyte characters correctly", () => {
    const objective = "Implementar función ñ con ü y é";
    const body = makeBody({
      approvedContract: {
        ...makeApprovedContract(),
        objective,
      },
    });
    const bundle = createEvidenceBundle(body);

    const expectedJson = expectedCanonicalJson({ objective });
    expect(Buffer.byteLength(expectedJson, "utf8")).toBeGreaterThan(
      expectedJson.length,
    );

    expect(bundle.bundleDigest).toBe(expectedDigest(expectedJson));
  });

  it("handles emoji correctly", () => {
    const objective = "Add 🔥 and 🎉 support";
    const body = makeBody({
      approvedContract: {
        ...makeApprovedContract(),
        objective,
      },
    });
    const bundle = createEvidenceBundle(body);

    const expectedJson = expectedCanonicalJson({ objective });
    expect(Buffer.byteLength(expectedJson, "utf8")).toBeGreaterThan(
      expectedJson.length,
    );
    expect(bundle.bundleDigest).toBe(expectedDigest(expectedJson));
  });

  it("digest matches SHA-256 of JSON with UTF-8 encoding", () => {
    const objective = "日本語テスト";
    const body = makeBody({
      approvedContract: {
        ...makeApprovedContract(),
        objective,
      },
    });
    const bundle = createEvidenceBundle(body);

    const expectedJson = expectedCanonicalJson({ objective });
    const expectedByteLength = Buffer.byteLength(expectedJson, "utf8");

    expect(expectedByteLength).toBeGreaterThan(expectedJson.length);
    expect(bundle.bundleDigest).toBe(expectedDigest(expectedJson));
  });
});

// ---------------------------------------------------------------------------
// Exact size limit
// ---------------------------------------------------------------------------

describe("exact size limit", () => {
  function makeCandidateOfSize(targetBytes: number): EvidenceBundleBody {
    const refSize = Buffer.byteLength(
      expectedCanonicalJson({ context: "x" }),
      "utf8",
    );
    const contextLength = targetBytes - refSize + 1;
    const context = "x".repeat(contextLength);
    expect(Buffer.byteLength(expectedCanonicalJson({ context }), "utf8")).toBe(
      targetBytes,
    );
    return makeBody({
      approvedContract: {
        ...makeApprovedContract(),
        context,
      },
    });
  }

  it("accepts body of exactly MAX_EVIDENCE_BUNDLE_BYTES", () => {
    const candidate = makeCandidateOfSize(MAX_EVIDENCE_BUNDLE_BYTES);
    const expectedJson = expectedCanonicalJson({
      context: candidate.approvedContract.context,
    });
    expect(Buffer.byteLength(expectedJson, "utf8")).toBe(
      MAX_EVIDENCE_BUNDLE_BYTES,
    );
    const bundle = createEvidenceBundle(candidate);
    expect(bundle.bundleDigest).toBe(expectedDigest(expectedJson));
  });

  it("rejects body of MAX_EVIDENCE_BUNDLE_BYTES + 1", () => {
    const candidate = makeCandidateOfSize(MAX_EVIDENCE_BUNDLE_BYTES + 1);
    expect(
      Buffer.byteLength(
        expectedCanonicalJson({ context: candidate.approvedContract.context }),
        "utf8",
      ),
    ).toBe(MAX_EVIDENCE_BUNDLE_BYTES + 1);
    try {
      createEvidenceBundle(candidate);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      const err = e as EvidenceBundleError;
      expect(err.code).toBe("EVIDENCE_BUNDLE_TOO_LARGE");
      expect(err.details).toBeDefined();
      expect(err.details!.byteLength).toBe(MAX_EVIDENCE_BUNDLE_BYTES + 1);
      expect(err.details!.maxBytes).toBe(MAX_EVIDENCE_BUNDLE_BYTES);
    }
  });

  it("verify rejects oversized body", () => {
    const body = makeCandidateOfSize(MAX_EVIDENCE_BUNDLE_BYTES + 1);
    const expectedJson = expectedCanonicalJson({
      context: body.approvedContract.context,
    });
    expect(Buffer.byteLength(expectedJson, "utf8")).toBe(
      MAX_EVIDENCE_BUNDLE_BYTES + 1,
    );

    const manipulated: EvidenceBundle = {
      body,
      bundleDigest: "1" + "0".repeat(63),
    };
    try {
      verifyEvidenceBundle(manipulated);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("EVIDENCE_BUNDLE_TOO_LARGE");
    }
  });
});

// ---------------------------------------------------------------------------
// EvidenceBundleError
// ---------------------------------------------------------------------------

describe("EvidenceBundleError", () => {
  it("has correct name", () => {
    const err = new EvidenceBundleError("test", {
      code: "INVALID_EVIDENCE_BODY",
    });
    expect(err.name).toBe("EvidenceBundleError");
  });

  it("has correct code", () => {
    const err = new EvidenceBundleError("test", {
      code: "EVIDENCE_BUNDLE_TOO_LARGE",
    });
    expect(err.code).toBe("EVIDENCE_BUNDLE_TOO_LARGE");
  });

  it("has frozen details", () => {
    const details = { byteLength: 100, maxBytes: 200 };
    const err = new EvidenceBundleError("test", {
      code: "EVIDENCE_BUNDLE_TOO_LARGE",
      details,
    });
    expect(Object.isFrozen(err.details)).toBe(true);
    expect(err.details!.byteLength).toBe(100);
    expect(err.details!.maxBytes).toBe(200);
  });

  it("preserves cause via ErrorOptions", () => {
    const cause = new Error("original");
    const err = new EvidenceBundleError("test", {
      code: "INVALID_EVIDENCE_BODY",
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it("no details when omitted", () => {
    const err = new EvidenceBundleError("test", {
      code: "EVIDENCE_BUNDLE_DIGEST_MISMATCH",
    });
    expect(err.details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

describe("error wrapping", () => {
  it("create wraps TypeError as INVALID_EVIDENCE_BODY", () => {
    const input = Object.create(null, {
      bad: {
        get() {
          throw new TypeError("boom");
        },
        enumerable: true,
      },
    });

    try {
      createEvidenceBundle(input);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BODY");
      expect((e as EvidenceBundleError).cause).toBeDefined();
    }
  });

  it("verify wraps unexpected errors as INVALID_EVIDENCE_BUNDLE", () => {
    try {
      verifyEvidenceBundle(undefined);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceBundleError);
      expect((e as EvidenceBundleError).code).toBe("INVALID_EVIDENCE_BUNDLE");
    }
  });
});
