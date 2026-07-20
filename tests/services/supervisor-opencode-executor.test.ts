import { describe, expect, it } from "vitest";

import { OpenCodeProcessError, runOpenCodeProcess, type OpenCodeProcessInput, type OpenCodeProcessResult } from "../../src/services/opencode-process-runner.js";
import { SupervisorOpenCodeInterpretationError } from "../../src/services/supervisor-opencode-integration.js";
import {
  runSupervisorWithOpenCode,
  type SupervisorExecutorDeps,
  type SupervisorRuntimeOptions,
} from "../../src/services/supervisor-opencode-executor.js";
import { buildSupervisorPrompt, type SupervisorPromptInput } from "../../src/services/supervisor-prompt-builder.js";
import type { SupervisorOpenCodeInterpretation } from "../../src/services/supervisor-opencode-integration.js";

type TestInputOverrides = {
  project?: Partial<SupervisorPromptInput["project"]>;
  task?: Partial<SupervisorPromptInput["task"]>;
  pendingHumanRequests?: SupervisorPromptInput["pendingHumanRequests"];
};

function createInput(overrides: TestInputOverrides = {}): SupervisorPromptInput {
  return {
    project: {
      name: "Alpha",
      repositoryPath: "/repo/main",
      ...(overrides.project ?? {}),
    },
    task: {
      id: "TASK-001",
      title: "Implement feature",
      description: "Build the first slice",
      state: "CREATED",
      attempt: 0,
      maxAttempts: 2,
      contractJson: null,
      currentRevisionJson: null,
      ...(overrides.task ?? {}),
    },
    pendingHumanRequests: overrides.pendingHumanRequests ?? [],
  };
}

function createRuntime(overrides: Partial<SupervisorRuntimeOptions> = {}): SupervisorRuntimeOptions {
  return {
    timeoutMs: 1234,
    ...overrides,
  };
}

function createProcessResult(overrides: Partial<OpenCodeProcessResult> = {}): OpenCodeProcessResult {
  return {
    binaryPath: "opencode",
    args: ["run", "--format", "json", "--dir", "/repo/main", "prompt"],
    cwd: "/repo/main",
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

function createInterpretation(): SupervisorOpenCodeInterpretation {
  return {
    supervisorResult: {
      classification: "NEEDS_DISCOVERY",
      summary: "Need more details",
      reasoning: "Missing input",
      missingInformation: ["API contract"],
      recommendedDiscoveryActions: ["Inspect docs"],
      openQuestions: ["Which API?"],
    },
    sessionID: "sess-1",
    messageID: "msg-1",
  };
}

describe("runSupervisorWithOpenCode", () => {
  it("uses repositoryPath as cwd and passes the built prompt", async () => {
    const input = createInput();
    const runtime = createRuntime();
    let capturedInput: OpenCodeProcessInput | null = null;
    let runCount = 0;
    let interpretCount = 0;
    const interpretation = createInterpretation();

    const deps: SupervisorExecutorDeps = {
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

    const output = await runSupervisorWithOpenCode(input, runtime, deps);

    expect(runCount).toBe(1);
    expect(interpretCount).toBe(1);
    if (capturedInput === null) {
      throw new Error("runner input was not captured");
    }

    const runnerInput = capturedInput;

    expect(runnerInput.cwd).toBe("/repo/main");
    expect(runnerInput.prompt).toBe(buildSupervisorPrompt(input));
    expect(runnerInput.timeoutMs).toBe(1234);
    expect(output).toBe(interpretation);
  });

  it("uses supervisor as default agent", async () => {
    let capturedAgent: string | undefined;

    await runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async (value: OpenCodeProcessInput) => {
        capturedAgent = value.agent;
        return createProcessResult();
      },
      interpretResult: () => createInterpretation(),
    });

    expect(capturedAgent).toBe("supervisor");
  });

  it("allows overriding the agent", async () => {
    let capturedAgent: string | undefined;

    await runSupervisorWithOpenCode(createInput(), createRuntime({ agent: "reviewer", timeoutMs: 1 }), {
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

    await runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 9876 }), {
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

    await runSupervisorWithOpenCode(createInput(), createRuntime(), {
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

    await runSupervisorWithOpenCode(createInput(), createRuntime({ model: "gpt-5.4-mini", timeoutMs: 1 }), {
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

    await runSupervisorWithOpenCode(
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

    const output = await runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async () => processResult,
      interpretResult: (value) => {
        received = value;
        return interpretation;
      },
    });

    expect(received).toBe(processResult);
    expect(output).toBe(interpretation);
  });

  it("propagates binary not found errors", async () => {
    const error = new OpenCodeProcessError("missing", {
      code: "BINARY_NOT_FOUND",
      binaryPath: "opencode",
      cwd: "/repo/main",
    });

    await expect(
      runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => {
          throw error;
        },
        interpretResult: () => createInterpretation(),
      }),
    ).rejects.toBe(error);
  });

  it("propagates spawn failed errors", async () => {
    const error = new OpenCodeProcessError("spawn failed", {
      code: "SPAWN_FAILED",
      binaryPath: "opencode",
      cwd: "/repo/main",
    });

    await expect(
      runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => {
          throw error;
        },
        interpretResult: () => createInterpretation(),
      }),
    ).rejects.toBe(error);
  });

  it("propagates interpretation errors", async () => {
    const error = new SupervisorOpenCodeInterpretationError("boom", {
      code: "OUTPUT_PARSE_FAILED",
      result: createProcessResult(),
    });

    await expect(
      runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
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
      runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
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
      runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
        runProcess: async () => createProcessResult(),
        interpretResult: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it("rejects an empty agent before calling the runner", async () => {
    let called = false;

    await expect(
      runSupervisorWithOpenCode(createInput(), createRuntime({ agent: "   ", timeoutMs: 1 }), {
        runProcess: async () => {
          called = true;
          return createProcessResult();
        },
        interpretResult: () => createInterpretation(),
      }),
    ).rejects.toThrow("El agente no puede estar vacío.");

    expect(called).toBe(false);
  });

  it("rejects an empty model before calling the runner", async () => {
    let called = false;

    await expect(
      runSupervisorWithOpenCode(createInput(), createRuntime({ model: "   ", timeoutMs: 1 }), {
        runProcess: async () => {
          called = true;
          return createProcessResult();
        },
        interpretResult: () => createInterpretation(),
      }),
    ).rejects.toThrow("El modelo no puede estar vacío.");

    expect(called).toBe(false);
  });

  it("does not mutate input, runtime or deps", async () => {
    const input = createInput({
      pendingHumanRequests: [
        {
          id: "req-1",
          type: "FUNCTIONAL_DECISION",
          question: "Need input",
          optionsJson: JSON.stringify(["A"]),
        },
      ],
    });
    const runtime: SupervisorRuntimeOptions = {
      timeoutMs: 1,
      agent: "supervisor",
      model: "gpt-5.4-mini",
      binaryPath: "/bin/opencode",
    };
    const deps: SupervisorExecutorDeps = {
      runProcess: async () => createProcessResult(),
      interpretResult: () => createInterpretation(),
    };

    const inputSnapshot = JSON.parse(JSON.stringify(input));
    const runtimeSnapshot = JSON.parse(JSON.stringify(runtime));

    await runSupervisorWithOpenCode(input, runtime, deps);

    expect(input).toEqual(inputSnapshot);
    expect(runtime).toEqual(runtimeSnapshot);
    expect(Object.keys(deps).sort()).toEqual(["interpretResult", "runProcess"]);
  });

  it("calls runner and interpreter exactly once", async () => {
    let runCount = 0;
    let interpretCount = 0;

    await runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
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

  it("does not require DB or applySupervisorResult", async () => {
    const output = await runSupervisorWithOpenCode(createInput(), createRuntime({ timeoutMs: 1 }), {
      runProcess: async () => createProcessResult(),
      interpretResult: () => createInterpretation(),
    });

    expect(output.supervisorResult.classification).toBe("NEEDS_DISCOVERY");
  });

  it("matches the real runner input contract at compile time", () => {
    const runProcess: typeof runOpenCodeProcess = async (value) => createProcessResult({
      cwd: value.cwd,
      args: ["run", "--format", "json", "--dir", value.cwd, value.prompt],
    });

    expect(runProcess).toBeTypeOf("function");
  });
});
