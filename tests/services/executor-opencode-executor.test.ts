import { describe, expect, it } from "vitest";

import { OpenCodeProcessError, type OpenCodeProcessInput, type OpenCodeProcessResult } from "../../src/services/opencode-process-runner.js";
import { ExecutorOpenCodeInterpretationError } from "../../src/services/executor-opencode-integration.js";
import {
  runExecutorWithOpenCode,
  type ExecutorExecutorDeps,
  type ExecutorRuntimeOptions,
} from "../../src/services/executor-opencode-executor.js";
import { buildExecutorPrompt, ExecutorPromptBuildError, type ExecutorPromptInput } from "../../src/services/executor-prompt-builder.js";
import type { ExecutorOpenCodeInterpretation } from "../../src/services/executor-opencode-integration.js";

type TestInputOverrides = {
  project?: Partial<ExecutorPromptInput["project"]>;
  task?: Partial<ExecutorPromptInput["task"]>;
  contract?: Partial<ExecutorPromptInput["contract"]>;
  workspace?: Partial<ExecutorPromptInput["workspace"]>;
};

function createInput(overrides: TestInputOverrides = {}): ExecutorPromptInput {
  return {
    project: {
      name: "Alpha",
      ...(overrides.project ?? {}),
    },
    task: {
      id: "TASK-001",
      title: "Implement feature",
      description: "Build the first slice",
      ...(overrides.task ?? {}),
    },
    contract: {
      objective: "Implement the approved feature.",
      context: "The release depends on this behavior.",
      acceptanceCriteria: ["Criterion 1"],
      allowedPaths: [],
      forbiddenPaths: [],
      requiredCommands: [],
      assumptions: [],
      risks: [],
      ...(overrides.contract ?? {}),
    },
    workspace: {
      workspacePath: "/tmp/devflow/worktree",
      branchName: "devflow/proj/task/execution-1",
      baseCommit: "abc123def456",
      executionNumber: 1,
      ...(overrides.workspace ?? {}),
    },
  };
}

function createRuntime(overrides: Partial<ExecutorRuntimeOptions> = {}): ExecutorRuntimeOptions {
  return {
    timeoutMs: 1234,
    ...overrides,
  };
}

function createProcessResult(overrides: Partial<OpenCodeProcessResult> = {}): OpenCodeProcessResult {
  return {
    binaryPath: "opencode",
    args: ["run", "--format", "json", "--dir", "/tmp/devflow/worktree", "prompt"],
    cwd: "/tmp/devflow/worktree",
    exitCode: 0,
    signal: null,
    stdout: "{}",
    stderr: "",
    durationMs: 10,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function createInterpretation(): ExecutorOpenCodeInterpretation {
  return {
    executorPayload: {
      filesClaimed: ["src/index.ts"],
      commandsClaimed: ["npm test"],
    },
    sessionID: "sess-1",
    messageID: "msg-1",
    envelope: {
      protocolVersion: 1,
      role: "executor",
      status: "COMPLETED",
      summary: "Feature implemented.",
      questions: [],
      risks: [],
      payload: {
        filesClaimed: ["src/index.ts"],
        commandsClaimed: ["npm test"],
      },
    },
  };
}

describe("runExecutorWithOpenCode", () => {
  it("uses workspacePath as cwd and passes the built prompt", async () => {
    const input = createInput();
    const runtime = createRuntime();
    let capturedInput: OpenCodeProcessInput | null = null;
    let runCount = 0;
    let interpretCount = 0;
    const interpretation = createInterpretation();

    const deps: ExecutorExecutorDeps = {
      runProcess: async (value: OpenCodeProcessInput) => {
        runCount += 1;
        capturedInput = value;
        return createProcessResult({ stdout: "{" });
      },
      interpretResult: (result) => {
        interpretCount += 1;
        expect(result.stdout).toBe("{");
        return interpretation;
      },
    };

    const output = await runExecutorWithOpenCode(input, runtime, deps);

    expect(runCount).toBe(1);
    expect(interpretCount).toBe(1);
    if (capturedInput === null) {
      throw new Error("runner input was not captured");
    }

    const runnerInput = capturedInput;

    expect(runnerInput.cwd).toBe("/tmp/devflow/worktree");
    expect(runnerInput.prompt).toBe(buildExecutorPrompt(input));
    expect(runnerInput.timeoutMs).toBe(1234);
    expect(output).toBe(interpretation);
  });

  it("uses executor as default agent", async () => {
    let capturedAgent: string | undefined;

    await runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async (value: OpenCodeProcessInput) => {
        capturedAgent = value.agent;
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(capturedAgent).toBe("executor");
  });

  it("allows overriding the agent", async () => {
    let capturedAgent: string | undefined;

    await runExecutorWithOpenCode(createInput(), createRuntime({ agent: "reviewer", timeoutMs: 1 }), {
      runProcess: async (value: OpenCodeProcessInput) => {
        capturedAgent = value.agent;
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(capturedAgent).toBe("reviewer");
  });

  it("passes timeoutMs to the runner exactly as provided", async () => {
    let seenTimeoutMs: number | undefined;

    await runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 9876 }), {
      runProcess: async (value: OpenCodeProcessInput) => {
        seenTimeoutMs = value.timeoutMs;
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(seenTimeoutMs).toBe(9876);
  });

  it("omits model, binaryPath and signal when they are not provided", async () => {
    let sawModel = false;
    let sawBinaryPath = false;
    let sawSignal = false;

    await runExecutorWithOpenCode(createInput(), createRuntime(), {
      runProcess: async (value: OpenCodeProcessInput) => {
        sawModel = Object.prototype.hasOwnProperty.call(value, "model");
        sawBinaryPath = Object.prototype.hasOwnProperty.call(value, "binaryPath");
        sawSignal = Object.prototype.hasOwnProperty.call(value, "signal");
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(sawModel).toBe(false);
    expect(sawBinaryPath).toBe(false);
    expect(sawSignal).toBe(false);
  });

  it("passes model when provided and omits it otherwise", async () => {
    let seenModel: string | undefined;

    await runExecutorWithOpenCode(createInput(), createRuntime({ model: "gpt-5.4-mini", timeoutMs: 1 }), {
      runProcess: async (value: OpenCodeProcessInput) => {
        seenModel = value.model;
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(seenModel).toBe("gpt-5.4-mini");
  });

  it("passes timeout, binaryPath and signal when provided", async () => {
    const signalController = new AbortController();
    let capturedTimeoutMs: number | undefined;
    let capturedBinaryPath: string | undefined;
    let capturedSignal: AbortSignal | undefined;

    await runExecutorWithOpenCode(
      createInput(),
      createRuntime({ timeoutMs: 9000, binaryPath: "/bin/opencode", signal: signalController.signal }),
      {
        runProcess: async (value: OpenCodeProcessInput) => {
          capturedTimeoutMs = value.timeoutMs;
          capturedBinaryPath = value.binaryPath;
          capturedSignal = value.signal;
          return createProcessResult();
        },
        interpretResult: () => createInterpretation(),
      },
    );

    expect(capturedTimeoutMs).toBe(9000);
    expect(capturedBinaryPath).toBe("/bin/opencode");
    expect(capturedSignal).toBe(signalController.signal);
  });

  it("forwards the runner result to the interpreter", async () => {
    const processResult = createProcessResult({ stdout: "raw" });
    let received: OpenCodeProcessResult | null = null;
    const interpretation = createInterpretation();

    const output = await runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async () => processResult,
      interpretResult: (value) => {
        received = value;
        return interpretation;
      },
    });

    expect(received).toBe(processResult);
    expect(output).toBe(interpretation);
  });

  it("rejects an empty agent before calling the runner", async () => {
    let runnerCalled = false;
    let interpreterCalled = false;

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ agent: "   ", timeoutMs: 1 }), {
        runProcess: async () => {
          runnerCalled = true;
          return createProcessResult();
        },
        interpretResult: () => {
          interpreterCalled = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow("El agente no puede estar vacío.");

    expect(runnerCalled).toBe(false);
    expect(interpreterCalled).toBe(false);
  });

  it("rejects a literal empty agent before calling the runner", async () => {
    let runnerCalled = false;
    let interpreterCalled = false;

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ agent: "", timeoutMs: 1 }), {
        runProcess: async () => {
          runnerCalled = true;
          return createProcessResult();
        },
        interpretResult: () => {
          interpreterCalled = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow("El agente no puede estar vacío.");

    expect(runnerCalled).toBe(false);
    expect(interpreterCalled).toBe(false);
  });

  it("rejects an empty model before calling the runner", async () => {
    let runnerCalled = false;
    let interpreterCalled = false;

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ model: "   ", timeoutMs: 1 }), {
        runProcess: async () => {
          runnerCalled = true;
          return createProcessResult();
        },
        interpretResult: () => {
          interpreterCalled = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow("El modelo no puede estar vacío.");

    expect(runnerCalled).toBe(false);
    expect(interpreterCalled).toBe(false);
  });

  it("rejects a literal empty model before calling the runner", async () => {
    let runnerCalled = false;
    let interpreterCalled = false;

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ model: "", timeoutMs: 1 }), {
        runProcess: async () => {
          runnerCalled = true;
          return createProcessResult();
        },
        interpretResult: () => {
          interpreterCalled = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow("El modelo no puede estar vacío.");

    expect(runnerCalled).toBe(false);
    expect(interpreterCalled).toBe(false);
  });

  it("propagates prompt build errors without wrapper", async () => {
    const input = createInput({ project: { name: "   " } });
    let runnerCalled = false;
    let interpreterCalled = false;

    try {
      await runExecutorWithOpenCode(input, createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => {
          runnerCalled = true;
          return createProcessResult();
        },
        interpretResult: () => {
          interpreterCalled = true;
          return createInterpretation();
        },
      });
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutorPromptBuildError);
      const typed = error as ExecutorPromptBuildError;
      expect(typed.name).toBe("ExecutorPromptBuildError");
      expect(typed.code).toBe("INVALID_PROJECT_NAME");
      expect(typed.path).toEqual(["project", "name"]);
    }

    expect(runnerCalled).toBe(false);
    expect(interpreterCalled).toBe(false);
  });

  it("propagates OpenCodeProcessError", async () => {
    const error = new OpenCodeProcessError("missing", {
      code: "BINARY_NOT_FOUND",
      binaryPath: "opencode",
      cwd: "/tmp/devflow/worktree",
    });

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => {
          throw error;
        },
        interpretResult: () => createInterpretation(),
      }),
    ).rejects.toBe(error);
  });

  it("propagates ExecutorOpenCodeInterpretationError", async () => {
    const error = new ExecutorOpenCodeInterpretationError("boom", {
      code: "PROCESS_EXIT_NOT_ZERO",
      result: createProcessResult(),
    });

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => createProcessResult(),
        interpretResult: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it("propagates unexpected runner errors", async () => {
    const error = new RangeError("runner failure");

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => {
          throw error;
        },
        interpretResult: () => createInterpretation(),
      }),
    ).rejects.toBe(error);
  });

  it("propagates unexpected interpreter errors", async () => {
    const error = new RangeError("interpreter failure");

    await expect(
      runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => createProcessResult(),
        interpretResult: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it("does not use repositoryPath as cwd", async () => {
    let capturedCwd: string | undefined;

    await runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async (value: OpenCodeProcessInput) => {
        capturedCwd = value.cwd;
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(capturedCwd).toBe("/tmp/devflow/worktree");
  });

  it("does not mutate input, runtime or deps", async () => {
    const input = createInput({
      contract: {
        acceptanceCriteria: ["Criterion 1"],
        allowedPaths: ["src/a.ts"],
        forbiddenPaths: [],
        requiredCommands: [],
        assumptions: [],
        risks: [],
      },
    });
    const runtime: ExecutorRuntimeOptions = {
      timeoutMs: 1,
      agent: "executor",
      model: "gpt-5.4-mini",
      binaryPath: "/bin/opencode",
    };
    const deps: ExecutorExecutorDeps = {
      runProcess: async () => createProcessResult(),
      interpretResult: () => createInterpretation(),
    };

    const inputSnapshot = JSON.parse(JSON.stringify(input));
    const runtimeSnapshot = JSON.parse(JSON.stringify(runtime));

    await runExecutorWithOpenCode(input, runtime, deps);

    expect(input).toEqual(inputSnapshot);
    expect(runtime).toEqual(runtimeSnapshot);
    expect(Object.keys(deps).sort()).toEqual(["interpretResult", "runProcess"]);
  });

  it("calls runner and interpreter exactly once", async () => {
    let runCount = 0;
    let interpretCount = 0;

    await runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async () => {
        runCount += 1;
        return createProcessResult();
      },
      interpretResult: () => {
        interpretCount += 1;
        return createInterpretation();
      },
    });

    expect(runCount).toBe(1);
    expect(interpretCount).toBe(1);
  });

  it("returns the exact interpretation from the interpreter", async () => {
    const interpretation = createInterpretation();

    const output = await runExecutorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async () => createProcessResult(),
      interpretResult: () => interpretation,
    });

    expect(output).toBe(interpretation);
  });
});
