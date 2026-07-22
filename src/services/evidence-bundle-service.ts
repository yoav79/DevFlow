import { createHash } from "node:crypto";
import {
  evidenceBundleBodySchema,
  evidenceBundleSchema,
  MAX_EVIDENCE_BUNDLE_BYTES,
} from "../schemas/evidence-bundle-schema.js";
import type {
  EvidenceBundle,
  EvidenceBundleBody,
} from "../schemas/evidence-bundle-schema.js";

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;

type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Public error types
// ---------------------------------------------------------------------------

export type EvidenceBundleErrorCode =
  | "INVALID_EVIDENCE_BODY"
  | "INVALID_EVIDENCE_BUNDLE"
  | "EVIDENCE_BUNDLE_TOO_LARGE"
  | "EVIDENCE_BUNDLE_DIGEST_MISMATCH";

export class EvidenceBundleError extends Error {
  readonly code: EvidenceBundleErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      readonly code: EvidenceBundleErrorCode;
      readonly cause?: unknown;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "EvidenceBundleError";
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

// ---------------------------------------------------------------------------
// Private normalizer
// ---------------------------------------------------------------------------

function normalizeEvidenceJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  errorCode: Extract<
    EvidenceBundleErrorCode,
    "INVALID_EVIDENCE_BODY" | "INVALID_EVIDENCE_BUNDLE"
  >,
): JsonValue {
  if (value === null) {
    return null;
  }

  const t = typeof value;

  if (t === "string" || t === "boolean") {
    return value as JsonPrimitive;
  }

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new EvidenceBundleError(
        `Unsupported number value: ${String(value)}`,
        { code: errorCode },
      );
    }
    return n;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new EvidenceBundleError(
        "Circular reference detected in array",
        { code: errorCode },
      );
    }
    ancestors.add(value);

    const result: JsonValue[] = [];
    try {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          throw new EvidenceBundleError(
            "Array contains a hole (sparse array)",
            { code: errorCode },
          );
        }
        const element = value[i];
        if (element === undefined) {
          throw new EvidenceBundleError(
            "Array contains undefined element",
            { code: errorCode },
          );
        }
        result.push(normalizeEvidenceJsonValue(element, ancestors, errorCode));
      }
    } finally {
      ancestors.delete(value);
    }

    return result;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;

    if (ancestors.has(obj)) {
      throw new EvidenceBundleError(
        "Circular reference detected in object",
        { code: errorCode },
      );
    }
    ancestors.add(obj);

    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, JsonValue> = {};

    try {
      for (const key of sortedKeys) {
        const v = obj[key];
        if (v === undefined) {
          continue;
        }
        result[key] = normalizeEvidenceJsonValue(v, ancestors, errorCode);
      }
    } finally {
      ancestors.delete(obj);
    }

    return result;
  }

  throw new EvidenceBundleError(
    `Unsupported value type: ${t}`,
    { code: errorCode },
  );
}

// ---------------------------------------------------------------------------
// Private canonicalization
// ---------------------------------------------------------------------------

interface CanonicalArtifacts {
  readonly normalizedBody: EvidenceBundleBody;
  readonly canonicalString: string;
  readonly byteLength: number;
  readonly digest: string;
}

function prepareCanonicalEvidenceBody(
  parsedBody: EvidenceBundleBody,
  errorCode: Extract<
    EvidenceBundleErrorCode,
    "INVALID_EVIDENCE_BODY" | "INVALID_EVIDENCE_BUNDLE"
  >,
): CanonicalArtifacts {
  const ancestors = new WeakSet<object>();
  const normalizedBody = normalizeEvidenceJsonValue(
    parsedBody,
    ancestors,
    errorCode,
  ) as EvidenceBundleBody;

  const revalidation = evidenceBundleBodySchema.safeParse(normalizedBody);
  if (!revalidation.success) {
    throw new EvidenceBundleError(
      "Normalized body failed schema revalidation",
      { code: errorCode, cause: revalidation.error },
    );
  }

  // Revalidation may rebuild object property order; normalize again before
  // serializing so the returned body and digest share the same canonical shape.
  const revalidationNormalized = normalizeEvidenceJsonValue(
    revalidation.data,
    new WeakSet<object>(),
    errorCode,
  ) as EvidenceBundleBody;

  const canonicalString = JSON.stringify(revalidationNormalized);

  if (typeof canonicalString !== "string") {
    throw new EvidenceBundleError(
      "Canonical serialization did not produce a string",
      { code: errorCode },
    );
  }

  const byteLength = Buffer.byteLength(canonicalString, "utf8");
  const digest = createHash("sha256")
    .update(canonicalString, "utf8")
    .digest("hex");

  return { normalizedBody: revalidationNormalized, canonicalString, byteLength, digest };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createEvidenceBundle(input: unknown): EvidenceBundle {
  try {
    const parseResult = evidenceBundleBodySchema.safeParse(input);
    if (!parseResult.success) {
      throw new EvidenceBundleError(
        `Invalid evidence bundle body: ${parseResult.error.issues.length} validation error(s)`,
        { code: "INVALID_EVIDENCE_BODY", cause: parseResult.error },
      );
    }

    const artifacts = prepareCanonicalEvidenceBody(
      parseResult.data,
      "INVALID_EVIDENCE_BODY",
    );

    if (artifacts.byteLength > MAX_EVIDENCE_BUNDLE_BYTES) {
      throw new EvidenceBundleError(
        `Evidence bundle body exceeds ${MAX_EVIDENCE_BUNDLE_BYTES} bytes`,
        {
          code: "EVIDENCE_BUNDLE_TOO_LARGE",
          details: {
            byteLength: artifacts.byteLength,
            maxBytes: MAX_EVIDENCE_BUNDLE_BYTES,
          },
        },
      );
    }

    const bundle: EvidenceBundle = {
      body: artifacts.normalizedBody,
      bundleDigest: artifacts.digest,
    };

    const bundleValidation = evidenceBundleSchema.safeParse(bundle);
    if (!bundleValidation.success) {
      throw new EvidenceBundleError(
        "Constructed bundle failed schema validation",
        { code: "INVALID_EVIDENCE_BODY", cause: bundleValidation.error },
      );
    }

    return { body: artifacts.normalizedBody, bundleDigest: artifacts.digest };
  } catch (error) {
    if (error instanceof EvidenceBundleError) {
      throw error;
    }
    throw new EvidenceBundleError(
      `Unexpected error during bundle creation: ${(error as Error).message}`,
      { code: "INVALID_EVIDENCE_BODY", cause: error },
    );
  }
}

export function verifyEvidenceBundle(input: unknown): EvidenceBundle {
  try {
    const parseResult = evidenceBundleSchema.safeParse(input);
    if (!parseResult.success) {
      throw new EvidenceBundleError(
        `Invalid evidence bundle: ${parseResult.error.issues.length} validation error(s)`,
        { code: "INVALID_EVIDENCE_BUNDLE", cause: parseResult.error },
      );
    }

    const parsed = parseResult.data;
    const artifacts = prepareCanonicalEvidenceBody(
      parsed.body,
      "INVALID_EVIDENCE_BUNDLE",
    );

    if (artifacts.byteLength > MAX_EVIDENCE_BUNDLE_BYTES) {
      throw new EvidenceBundleError(
        `Evidence bundle body exceeds ${MAX_EVIDENCE_BUNDLE_BYTES} bytes`,
        {
          code: "EVIDENCE_BUNDLE_TOO_LARGE",
          details: {
            byteLength: artifacts.byteLength,
            maxBytes: MAX_EVIDENCE_BUNDLE_BYTES,
          },
        },
      );
    }

    if (artifacts.digest !== parsed.bundleDigest) {
      throw new EvidenceBundleError(
        "Evidence bundle digest mismatch",
        { code: "EVIDENCE_BUNDLE_DIGEST_MISMATCH" },
      );
    }

    return { body: artifacts.normalizedBody, bundleDigest: parsed.bundleDigest };
  } catch (error) {
    if (error instanceof EvidenceBundleError) {
      throw error;
    }
    throw new EvidenceBundleError(
      `Unexpected error during bundle verification: ${(error as Error).message}`,
      { code: "INVALID_EVIDENCE_BUNDLE", cause: error },
    );
  }
}
