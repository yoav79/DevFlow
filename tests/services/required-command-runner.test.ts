import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runRequiredCommands,
  RequiredCommandRunnerError,
  type RequiredCommandProcessInput,
  type RequiredCommandProcessResult,
} from "../../src/services/required-command-runner.js";

function createMockCommand(
  overrides?: Partial<RequiredCommandProcessResult>,
): (
  input: RequiredCommandProcessInput,
) => Promise<RequiredCommandProcessResult> {
  return async (input) => ({
    command: input.command,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 10,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  });
}

function createSequentialMock(
  results: Array<Partial<RequiredCommandProcessResult>>,
): (
  input: RequiredCommandProcessInput,
) => Promise<RequiredCommandProcessResult> {
  let callCount = 0;

  return async (input) => {
    const override = results[callCount] ?? {};
    callCount += 1;

    return {
      command: input.command,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 10,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      ...override,
    };
  };
}

function createTrackingMock(): {
  mock: (
    input: RequiredCommandProcessInput,
  ) => Promise<RequiredCommandProcessResult>;
  calls: RequiredCommandProcessInput[];
} {
  const calls: RequiredCommandProcessInput[] = [];

  const mock = async (
    input: RequiredCommandProcessInput,
  ): Promise<RequiredCommandProcessResult> => {
    calls.push(input);

    return {
      command: input.command,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 10,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  };

  return { mock, calls };
}

function createTrackingSequentialMock(
  results: Array<Partial<RequiredCommandProcessResult>>,
): {
  mock: (
    input: RequiredCommandProcessInput,
  ) => Promise<RequiredCommandProcessResult>;
  calls: RequiredCommandProcessInput[];
} {
  const calls: RequiredCommandProcessInput[] = [];
  let callCount = 0;

  const mock = async (
    input: RequiredCommandProcessInput,
  ): Promise<RequiredCommandProcessResult> => {
    calls.push(input);
    const override = results[callCount] ?? {};
    callCount += 1;

    return {
      command: input.command,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 10,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      ...override,
    };
  };

  return { mock, calls };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runRequiredCommands", () => {
  describe("input validation", () => {
    it("rejects empty workspacePath", async () => {
      await expect(
        runRequiredCommands("", ["echo hello"], {
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("", ["echo hello"], {
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: "INVALID_WORKSPACE_PATH" });
    });

    it("rejects whitespace-only workspacePath", async () => {
      await expect(
        runRequiredCommands("   ", ["echo hello"], {
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("   ", ["echo hello"], {
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: "INVALID_WORKSPACE_PATH" });
    });

    it("rejects timeout 0", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 0,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 0,
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    });

    it("rejects negative timeout", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: -100,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: -100,
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    });

    it("rejects NaN timeout", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: NaN,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: NaN,
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    });

    it("rejects Infinity timeout", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: Number.POSITIVE_INFINITY,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: Number.POSITIVE_INFINITY,
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    });

    it("rejects non-integer timeout", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 100.5,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 100.5,
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    });

    it("rejects maxStdoutBytes 0", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStdoutBytes: 0,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStdoutBytes: 0,
        }),
      ).rejects.toMatchObject({ code: "INVALID_OUTPUT_LIMIT" });
    });

    it("rejects negative maxStdoutBytes", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStdoutBytes: -1,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStdoutBytes: -1,
        }),
      ).rejects.toMatchObject({ code: "INVALID_OUTPUT_LIMIT" });
    });

    it("rejects maxStderrBytes 0", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStderrBytes: 0,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStderrBytes: 0,
        }),
      ).rejects.toMatchObject({ code: "INVALID_OUTPUT_LIMIT" });
    });

    it("rejects negative maxStderrBytes", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStderrBytes: -1,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          maxStderrBytes: -1,
        }),
      ).rejects.toMatchObject({ code: "INVALID_OUTPUT_LIMIT" });
    });

    it("rejects empty command", async () => {
      await expect(
        runRequiredCommands("/tmp", [""], {
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", [""], {
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND", commandIndex: 0 });
    });

    it("rejects whitespace-only command", async () => {
      await expect(
        runRequiredCommands("/tmp", ["   "], {
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["   "], {
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND", commandIndex: 0 });
    });

    it("rejects invalid command at later index", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo ok", ""], {
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo ok", ""], {
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND", commandIndex: 1 });
    });

    it("rejects empty shellPath", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          shellPath: "",
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          shellPath: "",
        }),
      ).rejects.toMatchObject({ code: "INVALID_SHELL_PATH" });
    });

    it("rejects whitespace-only shellPath", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          shellPath: "   ",
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 1000,
          shellPath: "   ",
        }),
      ).rejects.toMatchObject({ code: "INVALID_SHELL_PATH" });
    });

    it("does not execute any command if workspacePath is invalid", async () => {
      const { mock, calls } = createTrackingMock();

      await expect(
        runRequiredCommands("", ["echo hello"], {
          timeoutMs: 1000,
        },
        { runCommand: mock }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      expect(calls).toHaveLength(0);
    });

    it("does not execute any command if commands contain invalid entry", async () => {
      const { mock, calls } = createTrackingMock();

      await expect(
        runRequiredCommands("/tmp", ["echo ok", ""], {
          timeoutMs: 1000,
        },
        { runCommand: mock }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      expect(calls).toHaveLength(0);
    });
  });

  describe("sequence", () => {
    it("returns empty results for empty commands", async () => {
      const result = await runRequiredCommands("/tmp", [], {
        timeoutMs: 1000,
      });

      expect(result.results).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.stoppedAtIndex).toBeNull();
    });

    it("executes single successful command", async () => {
      const { mock, calls } = createTrackingMock();

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(calls).toHaveLength(1);
      expect(result.results).toHaveLength(1);
      expect(result.passed).toBe(true);
      expect(result.stoppedAtIndex).toBeNull();
    });

    it("executes multiple commands in order", async () => {
      const { mock, calls } = createTrackingMock();

      const result = await runRequiredCommands(
        "/tmp",
        ["echo first", "echo second", "echo third"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(calls).toHaveLength(3);
      expect(calls[0].command).toBe("echo first");
      expect(calls[1].command).toBe("echo second");
      expect(calls[2].command).toBe("echo third");
      expect(result.results).toHaveLength(3);
      expect(result.passed).toBe(true);
      expect(result.stoppedAtIndex).toBeNull();
    });

    it("preserves exact command order", async () => {
      const { mock, calls } = createTrackingMock();

      await runRequiredCommands(
        "/tmp",
        ["cmd-a", "cmd-b", "cmd-c"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(calls.map((c) => c.command)).toEqual(["cmd-a", "cmd-b", "cmd-c"]);
    });

    it("passes cwd exactly as workspacePath without trim", async () => {
      const { mock, calls } = createTrackingMock();

      await runRequiredCommands("/tmp/test", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(calls[0].cwd).toBe("/tmp/test");
    });

    it("propagates runtime options", async () => {
      const { mock, calls } = createTrackingMock();
      const controller = new AbortController();

      await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 5000,
        shellPath: "/bin/bash",
        maxStdoutBytes: 1024,
        maxStderrBytes: 2048,
        signal: controller.signal,
      },
      { runCommand: mock });

      expect(calls[0].timeoutMs).toBe(5000);
      expect(calls[0].shellPath).toBe("/bin/bash");
      expect(calls[0].maxStdoutBytes).toBe(1024);
      expect(calls[0].maxStderrBytes).toBe(2048);
      expect(calls[0].signal).toBe(controller.signal);
    });
  });

  describe("fail-fast", () => {
    it("stops at first failed command", async () => {
      const { mock, calls } = createTrackingSequentialMock([
        { exitCode: 0 },
        { exitCode: 1 },
        { exitCode: 0 },
      ]);

      const result = await runRequiredCommands(
        "/tmp",
        ["echo ok", "failing-cmd", "echo never"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(calls).toHaveLength(2);
      expect(result.results).toHaveLength(2);
      expect(result.passed).toBe(false);
      expect(result.stoppedAtIndex).toBe(1);
    });

    it("does not execute commands after a failure", async () => {
      const { mock, calls } = createTrackingSequentialMock([
        { exitCode: 1 },
        { exitCode: 0 },
      ]);

      await runRequiredCommands(
        "/tmp",
        ["failing-cmd", "echo never"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(calls).toHaveLength(1);
    });

    it("reports stoppedAtIndex as the failing index", async () => {
      const { mock } = createTrackingSequentialMock([
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 1 },
      ]);

      const result = await runRequiredCommands(
        "/tmp",
        ["echo 1", "echo 2", "failing-cmd"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(result.stoppedAtIndex).toBe(2);
    });

    it("results contains only executed commands", async () => {
      const { mock } = createTrackingSequentialMock([
        { exitCode: 0 },
        { exitCode: 1 },
      ]);

      const result = await runRequiredCommands(
        "/tmp",
        ["echo ok", "failing-cmd", "echo never"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(result.results).toHaveLength(2);
      expect(result.results[0].command).toBe("echo ok");
      expect(result.results[1].command).toBe("failing-cmd");
    });

    it("each command executed exactly once", async () => {
      const { mock, calls } = createTrackingSequentialMock([
        { exitCode: 0 },
        { exitCode: 1 },
      ]);

      await runRequiredCommands(
        "/tmp",
        ["echo ok", "failing-cmd"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(calls).toHaveLength(2);
    });
  });

  describe("results", () => {
    it("returns exit code 0", async () => {
      const mock = createMockCommand({ exitCode: 0 });

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].exitCode).toBe(0);
      expect(result.results[0].passed).toBe(true);
    });

    it("returns exit code 1", async () => {
      const mock = createMockCommand({ exitCode: 1 });

      const result = await runRequiredCommands("/tmp", ["failing-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].exitCode).toBe(1);
      expect(result.results[0].passed).toBe(false);
    });

    it("returns exit code 127", async () => {
      const mock = createMockCommand({ exitCode: 127 });

      const result = await runRequiredCommands("/tmp", ["nonexistent-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].exitCode).toBe(127);
      expect(result.results[0].passed).toBe(false);
    });

    it("returns signal when terminated by signal", async () => {
      const mock = createMockCommand({
        exitCode: null,
        signal: "SIGTERM",
      });

      const result = await runRequiredCommands("/tmp", ["long-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].exitCode).toBeNull();
      expect(result.results[0].signal).toBe("SIGTERM");
      expect(result.results[0].passed).toBe(false);
    });

    it("marks timedOut result as not passed", async () => {
      const mock = createMockCommand({ timedOut: true, exitCode: null });

      const result = await runRequiredCommands("/tmp", ["slow-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].timedOut).toBe(true);
      expect(result.results[0].passed).toBe(false);
    });

    it("marks aborted result as not passed", async () => {
      const mock = createMockCommand({ aborted: true, exitCode: null });

      const result = await runRequiredCommands("/tmp", ["slow-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].aborted).toBe(true);
      expect(result.results[0].passed).toBe(false);
    });

    it("preserves stdout", async () => {
      const mock = createMockCommand({ stdout: "hello world" });

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].stdout).toBe("hello world");
    });

    it("preserves stderr", async () => {
      const mock = createMockCommand({ stderr: "error message" });

      const result = await runRequiredCommands("/tmp", ["failing-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].stderr).toBe("error message");
    });

    it("marks stdoutTruncated when exceeded", async () => {
      const mock = createMockCommand({ stdoutTruncated: true });

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].stdoutTruncated).toBe(true);
    });

    it("marks stderrTruncated when exceeded", async () => {
      const mock = createMockCommand({ stderrTruncated: true });

      const result = await runRequiredCommands("/tmp", ["failing-cmd"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0].stderrTruncated).toBe(true);
    });

    it("preserves command exactly", async () => {
      const mock = createMockCommand();

      const result = await runRequiredCommands(
        "/tmp",
        ["echo 'hello world'"],
        { timeoutMs: 1000 },
        { runCommand: mock },
      );

      expect(result.results[0].command).toBe("echo 'hello world'");
    });

    it("mapping is exact from process result", async () => {
      const mock = createMockCommand({
        command: "echo test",
        exitCode: 42,
        signal: "SIGKILL",
        stdout: "out",
        stderr: "err",
        durationMs: 123,
        timedOut: true,
        aborted: true,
        stdoutTruncated: true,
        stderrTruncated: true,
      });

      const result = await runRequiredCommands("/tmp", ["echo test"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results[0]).toEqual({
        command: "echo test",
        exitCode: 42,
        signal: "SIGKILL",
        stdout: "out",
        stderr: "err",
        durationMs: 123,
        timedOut: true,
        aborted: true,
        stdoutTruncated: true,
        stderrTruncated: true,
        passed: false,
      });
    });
  });

  describe("abort signal", () => {
    it("does not spawn when signal is already aborted", async () => {
      const { mock, calls } = createTrackingMock();
      const controller = new AbortController();
      controller.abort();

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
        signal: controller.signal,
      },
      { runCommand: mock });

      expect(calls).toHaveLength(0);
      expect(result.results[0].aborted).toBe(true);
      expect(result.results[0].exitCode).toBeNull();
      expect(result.results[0].signal).toBeNull();
      expect(result.results[0].stdout).toBe("");
      expect(result.results[0].stderr).toBe("");
      expect(result.results[0].timedOut).toBe(false);
      expect(result.results[0].passed).toBe(false);
    });

    it("aborts aggregate when signal pre-aborted", async () => {
      const { mock } = createTrackingMock();
      const controller = new AbortController();
      controller.abort();

      const result = await runRequiredCommands("/tmp", ["echo hello", "echo second"], {
        timeoutMs: 1000,
        signal: controller.signal,
      },
      { runCommand: mock });

      expect(result.passed).toBe(false);
      expect(result.stoppedAtIndex).toBe(0);
      expect(result.results).toHaveLength(1);
    });

    it("aborts during execution terminates process", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rcr-abort-"));
      const pidFile = join(dir, "child.pid");

      try {
        const controller = new AbortController();

        const resultPromise = runRequiredCommands(
          dir,
          [`sh -c 'echo $$ > "${pidFile}" && sleep 30'`],
          { timeoutMs: 10000, signal: controller.signal },
        );

        // Wait briefly for process to start
        await new Promise((r) => setTimeout(r, 200));

        const pidContent = await readFile(pidFile, "utf8").catch(() => "");
        const childPid = pidContent.trim() ? Number(pidContent.trim()) : null;

        controller.abort();
        const result = await resultPromise;

        expect(result.results[0].aborted).toBe(true);
        expect(result.results[0].passed).toBe(false);

        if (childPid !== null && childPid > 0) {
          expect(isProcessAlive(childPid)).toBe(false);
        }
      } finally {
        const pidContent = await readFile(pidFile, "utf8").catch(() => "");
        const childPid = pidContent.trim() ? Number(pidContent.trim()) : null;
        if (childPid !== null && childPid > 0 && isProcessAlive(childPid)) {
          try { process.kill(childPid, "SIGKILL"); } catch { /* already dead */ }
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("real process", () => {
    it("captures stdout", async () => {
      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 5000,
      });

      expect(result.results[0].stdout.trim()).toBe("hello");
      expect(result.results[0].exitCode).toBe(0);
      expect(result.results[0].passed).toBe(true);
    });

    it("captures stderr", async () => {
      const result = await runRequiredCommands(
        "/tmp",
        ["echo error >&2"],
        { timeoutMs: 5000 },
      );

      expect(result.results[0].stderr.trim()).toBe("error");
      expect(result.results[0].exitCode).toBe(0);
    });

    it("returns exit code 0", async () => {
      const result = await runRequiredCommands("/tmp", ["true"], {
        timeoutMs: 5000,
      });

      expect(result.results[0].exitCode).toBe(0);
      expect(result.results[0].passed).toBe(true);
    });

    it("returns exit code non-zero", async () => {
      const result = await runRequiredCommands("/tmp", ["false"], {
        timeoutMs: 5000,
      });

      expect(result.results[0].exitCode).toBe(1);
      expect(result.results[0].passed).toBe(false);
    });

    it("uses correct cwd", async () => {
      const result = await runRequiredCommands("/tmp", ["pwd"], {
        timeoutMs: 5000,
      });

      expect(result.results[0].stdout.trim()).toBe("/tmp");
    });

    it("supports shell syntax with pipe", async () => {
      const result = await runRequiredCommands(
        "/tmp",
        ["echo hello | tr 'h' 'H'"],
        { timeoutMs: 5000 },
      );

      expect(result.results[0].stdout.trim()).toBe("Hello");
    });

    it("supports shell syntax with &&", async () => {
      const result = await runRequiredCommands(
        "/tmp",
        ["echo hello && echo world"],
        { timeoutMs: 5000 },
      );

      expect(result.results[0].stdout.trim()).toBe("hello\nworld");
    });

    it("handles timeout and kills child process", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rcr-timeout-"));
      const pidFile = join(dir, "child.pid");

      try {
        const result = await runRequiredCommands(
          dir,
          [`sh -c 'echo $$ > "${pidFile}" && sleep 30'`],
          { timeoutMs: 500 },
        );

        expect(result.results[0].timedOut).toBe(true);
        expect(result.results[0].passed).toBe(false);
        expect(result.results[0].exitCode).toBeNull();
        expect(typeof result.results[0].durationMs).toBe("number");
        expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);

        // Verify child process is dead
        const pidContent = await readFile(pidFile, "utf8").catch(() => "");
        const childPid = pidContent.trim() ? Number(pidContent.trim()) : null;

        if (childPid !== null && childPid > 0) {
          expect(isProcessAlive(childPid)).toBe(false);
        }
      } finally {
        const pidContent = await readFile(pidFile, "utf8").catch(() => "");
        const childPid = pidContent.trim() ? Number(pidContent.trim()) : null;
        if (childPid !== null && childPid > 0 && isProcessAlive(childPid)) {
          try { process.kill(childPid, "SIGKILL"); } catch { /* already dead */ }
        }
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("handles non-existent shellPath", async () => {
      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 5000,
          shellPath: "/nonexistent/shell",
        }),
      ).rejects.toThrow(RequiredCommandRunnerError);

      await expect(
        runRequiredCommands("/tmp", ["echo hello"], {
          timeoutMs: 5000,
          shellPath: "/nonexistent/shell",
        }),
      ).rejects.toMatchObject({ code: "SHELL_NOT_FOUND" });
    });
  });

  describe("race conditions", () => {
    it("resolves only once on timeout and close simultaneously", async () => {
      let resolveCount = 0;

      const mock = async (
        input: RequiredCommandProcessInput,
      ): Promise<RequiredCommandProcessResult> => {
        resolveCount += 1;

        return {
          command: input.command,
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 10,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      };

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(resolveCount).toBe(1);
      expect(result.results).toHaveLength(1);
    });

    it("resolves only once on abort and close simultaneously", async () => {
      let resolveCount = 0;

      const mock = async (
        input: RequiredCommandProcessInput,
      ): Promise<RequiredCommandProcessResult> => {
        resolveCount += 1;

        return {
          command: input.command,
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 10,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      };

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(resolveCount).toBe(1);
      expect(result.results).toHaveLength(1);
    });

    it("handles error and close race", async () => {
      let resolveCount = 0;

      const mock = async (
        input: RequiredCommandProcessInput,
      ): Promise<RequiredCommandProcessResult> => {
        resolveCount += 1;

        return {
          command: input.command,
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          durationMs: 10,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      };

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(resolveCount).toBe(1);
      expect(result.results).toHaveLength(1);
    });

    it("cleanup removes all timers and listeners", async () => {
      const mock = createMockCommand();

      const result = await runRequiredCommands("/tmp", ["echo hello"], {
        timeoutMs: 1000,
      },
      { runCommand: mock });

      expect(result.results).toHaveLength(1);
      expect(result.passed).toBe(true);
    });
  });

  describe("error class", () => {
    it("sets code", () => {
      const error = new RequiredCommandRunnerError("test", {
        code: "INVALID_WORKSPACE_PATH",
      });

      expect(error.code).toBe("INVALID_WORKSPACE_PATH");
    });

    it("sets command", () => {
      const error = new RequiredCommandRunnerError("test", {
        code: "INVALID_COMMAND",
        command: "echo hello",
      });

      expect(error.command).toBe("echo hello");
    });

    it("sets commandIndex", () => {
      const error = new RequiredCommandRunnerError("test", {
        code: "INVALID_COMMAND",
        commandIndex: 2,
      });

      expect(error.commandIndex).toBe(2);
    });

    it("sets shellPath", () => {
      const error = new RequiredCommandRunnerError("test", {
        code: "SHELL_NOT_FOUND",
        shellPath: "/bin/sh",
      });

      expect(error.shellPath).toBe("/bin/sh");
    });

    it("sets cause", () => {
      const cause = new Error("original");
      const error = new RequiredCommandRunnerError("test", {
        code: "SPAWN_FAILED",
        cause,
      });

      expect(error.cause).toBe(cause);
    });

    it("is instanceof Error", () => {
      const error = new RequiredCommandRunnerError("test", {
        code: "INVALID_WORKSPACE_PATH",
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("RequiredCommandRunnerError");
    });
  });
});
