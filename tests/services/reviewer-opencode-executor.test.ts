import { describe, expect, it, vi } from "vitest";

import { OpenCodeProcessError, runOpenCodeProcess, type OpenCodeProcessInput, type OpenCodeProcessResult } from "../../src/services/opencode-process-runner.js";
import {
  runReviewerWithOpenCode,
  ReviewerExecutionError,
  type ReviewerExecutorDeps,
  type ReviewerExecutionResult,
  type ReviewerRuntimeOptions,
} from "../../src/services/reviewer-opencode-executor.js";
import { buildReviewerPrompt } from "../../src/services/reviewer-prompt-builder.js";
import type { ReviewerPromptInput } from "../../src/schemas/reviewer-prompt-input-schema.js";

const HASH_AAA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GIT_OID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GIT_OID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeBody(overrides?: Partial<ReviewerPromptInput["evidenceBundle"]["body"]>): ReviewerPromptInput["evidenceBundle"]["body"] {
  return {
    version: 1 as const,
    baseCommit: GIT_OID_A,
    headCommit: GIT_OID_B,
    workspaceFingerprint: HASH_AAA,
    files: [],
    deterministicRevision: {
      status: "REVIEWING",
      pathValidation: { passed: true, violations: [] },
      commandsResult: null,
    },
    previousCorrections: [],
    approvedContract: {
      objective: "Implement feature X",
      context: "Project context",
      acceptanceCriteria: ["Criterion 1"],
      allowedPaths: ["src/"],
      forbiddenPaths: ["dist/"],
      requiredCommands: ["npm test"],
      assumptions: ["Node 24"],
      risks: ["Low confidence"],
    },
    ...overrides,
  };
}

function makeInput(bodyOverrides?: Partial<ReviewerPromptInput["evidenceBundle"]["body"]>): ReviewerPromptInput {
  return {
    version: 1 as const,
    reviewNumber: 1,
    evidenceBundle: {
      body: makeBody(bodyOverrides),
      bundleDigest: HASH_AAA,
    },
  };
}

function makeRuntime(overrides: Partial<ReviewerRuntimeOptions> = {}): ReviewerRuntimeOptions {
  return {
    cwd: "/workspace/repo",
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeProcessResult(overrides: Partial<OpenCodeProcessResult> = {}): OpenCodeProcessResult {
  return {
    binaryPath: "opencode",
    args: ["run", "--format", "json", "--dir", "/workspace/repo", "--agent", "reviewer", "prompt"],
    cwd: "/workspace/repo",
    exitCode: 0,
    signal: null,
    stdout: '{"verdict":"APPROVED"}',
    stderr: "",
    durationMs: 42,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

describe("runReviewerWithOpenCode", () => {
  // ---------------------------------------------------------------------------
  // API surface
  // ---------------------------------------------------------------------------

  it("returns a ReviewerExecutionResult with exactly seven fields on success", async () => {
    let runCount = 0;
    const deps: ReviewerExecutorDeps = {
      runProcess: async () => {
        runCount += 1;
        return makeProcessResult();
      },
    };

    const result: ReviewerExecutionResult = await runReviewerWithOpenCode(makeInput(), makeRuntime(), deps);

    expect(runCount).toBe(1);
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("signal");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("aborted");
    expect(Object.keys(result).length).toBe(7);

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('{"verdict":"APPROVED"}');
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBe(42);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it("does not expose prompt, args, cwd, stdoutTruncated, stderrTruncated on the result", async () => {
    const deps: ReviewerExecutorDeps = {
      runProcess: async () => makeProcessResult(),
    };

    const result: ReviewerExecutionResult = await runReviewerWithOpenCode(makeInput(), makeRuntime(), deps);

    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("args");
    expect(result).not.toHaveProperty("cwd");
    expect(result).not.toHaveProperty("stdoutTruncated");
    expect(result).not.toHaveProperty("stderrTruncated");
  });

  // ---------------------------------------------------------------------------
  // Builder and runner invocation
  // ---------------------------------------------------------------------------

  it("calls buildPrompt exactly once with the original input", async () => {
    const buildPrompt = vi.fn<typeof buildReviewerPrompt>();
    buildPrompt.mockReturnValue("mocked-prompt");

    const deps: ReviewerExecutorDeps = {
      buildPrompt,
      runProcess: async (value) => {
        expect(value.prompt).toBe("mocked-prompt");
        return makeProcessResult();
      },
    };

    await runReviewerWithOpenCode(makeInput(), makeRuntime(), deps);

    expect(buildPrompt).toHaveBeenCalledTimes(1);
  });

  it("calls runProcess exactly once", async () => {
    const runProcess = vi.fn<typeof runOpenCodeProcess>();
    runProcess.mockResolvedValue(makeProcessResult());

    await runReviewerWithOpenCode(makeInput(), makeRuntime(), { runProcess });

    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("does not execute runProcess when buildPrompt throws", async () => {
    const buildPrompt = vi.fn<typeof buildReviewerPrompt>();
    buildPrompt.mockImplementation(() => { throw new Error("build error"); });
    const runProcess = vi.fn<typeof runOpenCodeProcess>();

    await expect(
      runReviewerWithOpenCode(makeInput(), makeRuntime(), { buildPrompt, runProcess }),
    ).rejects.toThrow("build error");

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("does not execute runProcess when agent override is invalid (empty)", async () => {
    const runProcess = vi.fn<typeof runOpenCodeProcess>();

    await expect(
      runReviewerWithOpenCode(makeInput(), makeRuntime({ agent: "" }), { runProcess }),
    ).rejects.toThrow("El agente no puede estar vacío.");

    expect(runProcess).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Runner input fields
  // ---------------------------------------------------------------------------

  it("propagates cwd to runner input", async () => {
    let capturedCwd: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ cwd: "/custom/path" }), {
      runProcess: async (value) => {
        capturedCwd = value.cwd;
        return makeProcessResult();
      },
    });

    expect(capturedCwd).toBe("/custom/path");
  });

  it("propagates timeoutMs to runner input", async () => {
    let capturedTimeout: number | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ timeoutMs: 9999 }), {
      runProcess: async (value) => {
        capturedTimeout = value.timeoutMs;
        return makeProcessResult();
      },
    });

    expect(capturedTimeout).toBe(9999);
  });

  it("uses 'reviewer' as default agent", async () => {
    let capturedAgent: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async (value) => {
        capturedAgent = value.agent;
        return makeProcessResult();
      },
    });

    expect(capturedAgent).toBe("reviewer");
  });

  it("allows overriding the agent", async () => {
    let capturedAgent: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ agent: "custom-agent" }), {
      runProcess: async (value) => {
        capturedAgent = value.agent;
        return makeProcessResult();
      },
    });

    expect(capturedAgent).toBe("custom-agent");
  });

  it("trims the agent override", async () => {
    let capturedAgent: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ agent: "  custom-agent  " }), {
      runProcess: async (value) => {
        capturedAgent = value.agent;
        return makeProcessResult();
      },
    });

    expect(capturedAgent).toBe("custom-agent");
  });

  it("allows overriding the model", async () => {
    let capturedModel: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ model: "gpt-4" }), {
      runProcess: async (value) => {
        capturedModel = value.model;
        return makeProcessResult();
      },
    });

    expect(capturedModel).toBe("gpt-4");
  });

  it("trims the model override", async () => {
    let capturedModel: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ model: "  claude-3  " }), {
      runProcess: async (value) => {
        capturedModel = value.model;
        return makeProcessResult();
      },
    });

    expect(capturedModel).toBe("claude-3");
  });

  it("rejects empty agent override", async () => {
    await expect(
      runReviewerWithOpenCode(makeInput(), makeRuntime({ agent: "  " }), {
        runProcess: async () => makeProcessResult(),
      }),
    ).rejects.toThrow("El agente no puede estar vacío.");
  });

  it("rejects empty model override", async () => {
    await expect(
      runReviewerWithOpenCode(makeInput(), makeRuntime({ model: "  " }), {
        runProcess: async () => makeProcessResult(),
      }),
    ).rejects.toThrow("El modelo no puede estar vacío.");
  });

  it("propagates binaryPath to runner input", async () => {
    let capturedBinaryPath: string | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ binaryPath: "/custom/opencode" }), {
      runProcess: async (value) => {
        capturedBinaryPath = value.binaryPath;
        return makeProcessResult();
      },
    });

    expect(capturedBinaryPath).toBe("/custom/opencode");
  });

  it("propagates signal to runner input", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    await runReviewerWithOpenCode(makeInput(), makeRuntime({ signal: controller.signal }), {
      runProcess: async (value) => {
        capturedSignal = value.signal;
        return makeProcessResult();
      },
    });

    expect(capturedSignal).toBe(controller.signal);
  });

  it("omits optional fields when not provided", async () => {
    let sawModel = false;
    let sawBinaryPath = false;
    let sawSignal = false;

    await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async (value) => {
        sawModel = Object.prototype.hasOwnProperty.call(value, "model");
        sawBinaryPath = Object.prototype.hasOwnProperty.call(value, "binaryPath");
        sawSignal = Object.prototype.hasOwnProperty.call(value, "signal");
        return makeProcessResult();
      },
    });

    expect(sawModel).toBe(false);
    expect(sawBinaryPath).toBe(false);
    expect(sawSignal).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Result fields
  // ---------------------------------------------------------------------------

  it("preserves stdout from process result", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ stdout: "custom-out" }),
    });

    expect(result.stdout).toBe("custom-out");
  });

  it("preserves stderr from process result", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ stderr: "custom-err" }),
    });

    expect(result.stderr).toBe("custom-err");
  });

  it("preserves exitCode when zero", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ exitCode: 0 }),
    });

    expect(result.exitCode).toBe(0);
  });

  it("preserves exitCode when non-zero (does not error)", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ exitCode: 1 }),
    });

    expect(result.exitCode).toBe(1);
  });

  it("preserves signal when non-null (does not error)", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ signal: "SIGTERM" }),
    });

    expect(result.signal).toBe("SIGTERM");
  });

  it("preserves timedOut when true (does not error)", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ timedOut: true }),
    });

    expect(result.timedOut).toBe(true);
  });

  it("preserves aborted when true (does not error)", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ aborted: true }),
    });

    expect(result.aborted).toBe(true);
  });

  it("preserves empty stdout (does not error)", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ stdout: "" }),
    });

    expect(result.stdout).toBe("");
  });

  it("preserves stderr with exit code zero (does not error)", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ stderr: "warning: something" }),
    });

    expect(result.stderr).toBe("warning: something");
    expect(result.exitCode).toBe(0);
  });

  it("preserves durationMs from process result", async () => {
    const result = await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
      runProcess: async () => makeProcessResult({ durationMs: 1234 }),
    });

    expect(result.durationMs).toBe(1234);
  });

  // ---------------------------------------------------------------------------
  // Truncation errors
  // ---------------------------------------------------------------------------

  it("throws ReviewerExecutionError when stdout is truncated", async () => {
    await expect(
      runReviewerWithOpenCode(makeInput(), makeRuntime(), {
        runProcess: async () => makeProcessResult({ stdoutTruncated: true }),
      }),
    ).rejects.toBeInstanceOf(ReviewerExecutionError);
  });

  it("throws ReviewerExecutionError when stderr is truncated", async () => {
    await expect(
      runReviewerWithOpenCode(makeInput(), makeRuntime(), {
        runProcess: async () => makeProcessResult({ stderrTruncated: true }),
      }),
    ).rejects.toBeInstanceOf(ReviewerExecutionError);
  });

  it("throws a single ReviewerExecutionError when both streams are truncated", async () => {
    let error: unknown;
    try {
      await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
        runProcess: async () => makeProcessResult({ stdoutTruncated: true, stderrTruncated: true }),
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ReviewerExecutionError);
    if (error instanceof ReviewerExecutionError) {
      expect(error.code).toBe("OUTPUT_TRUNCATED");
      expect(error.name).toBe("ReviewerExecutionError");
      expect(error.message).toBe("Output truncation detected.");
      expect(error.details.stdoutTruncated).toBe(true);
      expect(error.details.stderrTruncated).toBe(true);
    }
  });

  it("details is frozen and contains only stdoutTruncated/stderrTruncated", async () => {
    let error: unknown;
    try {
      await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
        runProcess: async () => makeProcessResult({ stdoutTruncated: true }),
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ReviewerExecutionError);
    if (error instanceof ReviewerExecutionError) {
      expect(Object.isFrozen(error.details)).toBe(true);
      expect(Object.keys(error.details)).toEqual(["stdoutTruncated", "stderrTruncated"]);
      expect(error.details).not.toHaveProperty("stdout");
      expect(error.details).not.toHaveProperty("stderr");
    }
  });

  it("details does not contain stdout or stderr content", async () => {
    let error: unknown;
    try {
      await runReviewerWithOpenCode(makeInput(), makeRuntime(), {
        runProcess: async () => makeProcessResult({ stdoutTruncated: true, stdout: "partial" }),
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ReviewerExecutionError);
    if (error instanceof ReviewerExecutionError) {
      expect(error.details).not.toHaveProperty("stdout");
      expect(error.details).not.toHaveProperty("stderr");
    }
  });

  // ---------------------------------------------------------------------------
  // OpenCodeProcessError propagation
  // ---------------------------------------------------------------------------

  it("propagates OpenCodeProcessError by identity (not caught, not wrapped)", async () => {
    const originalError = new OpenCodeProcessError(
      "No se encontró el binario de OpenCode: opencode",
      { code: "BINARY_NOT_FOUND", binaryPath: "opencode", cwd: "/workspace/repo" },
    );

    const runProcess = vi.fn<typeof runOpenCodeProcess>();
    runProcess.mockRejectedValue(originalError);

    let thrown: unknown;
    try {
      await runReviewerWithOpenCode(makeInput(), makeRuntime(), { runProcess });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(originalError);
    expect(thrown).toBeInstanceOf(OpenCodeProcessError);
    if (thrown instanceof OpenCodeProcessError) {
      expect(thrown.code).toBe("BINARY_NOT_FOUND");
    }
  });

  // ---------------------------------------------------------------------------
  // Immutability and scope
  // ---------------------------------------------------------------------------

  it("does not mutate the input", async () => {
    const input = makeInput();
    const snapshot = JSON.parse(JSON.stringify(input));

    await runReviewerWithOpenCode(input, makeRuntime(), {
      runProcess: async () => makeProcessResult(),
    });

    expect(input).toEqual(snapshot);
  });

  it("does not mutate the runtime", async () => {
    const runtime = makeRuntime();
    const snapshot = JSON.parse(JSON.stringify(runtime));

    await runReviewerWithOpenCode(makeInput(), runtime, {
      runProcess: async () => makeProcessResult(),
    });

    expect(runtime).toEqual(snapshot);
  });

  it("executes exactly once (no retry, no loop)", async () => {
    const runProcess = vi.fn<typeof runOpenCodeProcess>();
    runProcess.mockResolvedValue(makeProcessResult());

    await runReviewerWithOpenCode(makeInput(), makeRuntime(), { runProcess });

    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});
