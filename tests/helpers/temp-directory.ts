import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface TempDirectory {
  path: string;
  cleanup(): void;
}

function normalizePrefix(prefix?: string): string {
  const fallback = "devflow-test-";

  if (prefix === undefined) {
    return fallback;
  }

  const trimmed = prefix.trim();

  if (trimmed.length === 0) {
    return fallback;
  }

  const baseName = basename(trimmed);
  const normalized = baseName.endsWith("-") ? baseName : `${baseName}-`;

  return normalized.length === 1 ? fallback : normalized;
}

export function createTempDirectory(prefix?: string): TempDirectory {
  const normalizedPrefix = normalizePrefix(prefix);
  const path = mkdtempSync(join(tmpdir(), normalizedPrefix));
  let cleaned = false;

  return {
    path,
    cleanup(): void {
      if (cleaned) {
        return;
      }

      cleaned = true;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
