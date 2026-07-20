/// <reference types="node" />

import { spawn } from "node:child_process";

const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;
const DEFAULT_SHELL_PATH = "/bin/sh";
const GRACE_PERIOD_MS = 3000;

export interface RequiredCommandRuntimeOptions {
  readonly timeoutMs: number;
  readonly shellPath?: string;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RequiredCommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly passed: boolean;
}

export interface RequiredCommandsExecutionResult {
  readonly results: readonly RequiredCommandResult[];
  readonly passed: boolean;
  readonly stoppedAtIndex: number | null;
}

export interface RequiredCommandProcessInput {
  readonly command: string;
  readonly cwd: string;
  readonly shellPath: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}

export interface RequiredCommandProcessResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type RequiredCommandRunnerErrorCode =
  | "INVALID_WORKSPACE_PATH"
  | "INVALID_COMMAND"
  | "INVALID_TIMEOUT"
  | "INVALID_OUTPUT_LIMIT"
  | "INVALID_SHELL_PATH"
  | "SHELL_NOT_FOUND"
  | "SPAWN_FAILED";

export class RequiredCommandRunnerError extends Error {
  readonly code: RequiredCommandRunnerErrorCode;
  readonly command?: string;
  readonly commandIndex?: number;
  readonly shellPath?: string;

  constructor(
    message: string,
    options: {
      code: RequiredCommandRunnerErrorCode;
      command?: string;
      commandIndex?: number;
      shellPath?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "RequiredCommandRunnerError";
    this.code = options.code;
    if (options.command !== undefined) {
      this.command = options.command;
    }
    if (options.commandIndex !== undefined) {
      this.commandIndex = options.commandIndex;
    }
    if (options.shellPath !== undefined) {
      this.shellPath = options.shellPath;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface RequiredCommandRunnerDeps {
  readonly runCommand?: (
    input: RequiredCommandProcessInput,
  ) => Promise<RequiredCommandProcessResult>;
}

function validateWorkspacePath(workspacePath: string): void {
  if (typeof workspacePath !== "string") {
    throw new RequiredCommandRunnerError(
      "El directorio de trabajo debe ser un string.",
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }

  if (workspacePath.trim().length === 0) {
    throw new RequiredCommandRunnerError(
      "El directorio de trabajo no puede estar vacío o contener solo espacios.",
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }
}

function validateCommand(
  command: unknown,
  index: number,
): command is string {
  if (typeof command !== "string") {
    throw new RequiredCommandRunnerError(
      `El comando en el índice ${index} debe ser un string.`,
      { code: "INVALID_COMMAND", commandIndex: index },
    );
  }

  if (command.trim().length === 0) {
    throw new RequiredCommandRunnerError(
      `El comando en el índice ${index} no puede estar vacío o contener solo espacios.`,
      { code: "INVALID_COMMAND", command, commandIndex: index },
    );
  }

  return true;
}

function validateRuntime(runtime: RequiredCommandRuntimeOptions): {
  timeoutMs: number;
  shellPath: string;
  maxStdoutBytes: number;
  maxStderrBytes: number;
} {
  if (
    typeof runtime.timeoutMs !== "number" ||
    !Number.isFinite(runtime.timeoutMs) ||
    runtime.timeoutMs <= 0 ||
    !Number.isInteger(runtime.timeoutMs)
  ) {
    throw new RequiredCommandRunnerError(
      "El timeout debe ser un entero positivo.",
      { code: "INVALID_TIMEOUT" },
    );
  }

  const shellPath =
    runtime.shellPath !== undefined ? runtime.shellPath : DEFAULT_SHELL_PATH;

  if (typeof shellPath !== "string" || shellPath.trim().length === 0) {
    throw new RequiredCommandRunnerError(
      "El path del shell no puede estar vacío.",
      { code: "INVALID_SHELL_PATH", shellPath },
    );
  }

  const maxStdoutBytes =
    runtime.maxStdoutBytes !== undefined
      ? runtime.maxStdoutBytes
      : DEFAULT_MAX_STDOUT_BYTES;

  if (
    typeof maxStdoutBytes !== "number" ||
    !Number.isFinite(maxStdoutBytes) ||
    maxStdoutBytes <= 0 ||
    !Number.isInteger(maxStdoutBytes)
  ) {
    throw new RequiredCommandRunnerError(
      "El límite de stdout debe ser un entero positivo.",
      { code: "INVALID_OUTPUT_LIMIT" },
    );
  }

  const maxStderrBytes =
    runtime.maxStderrBytes !== undefined
      ? runtime.maxStderrBytes
      : DEFAULT_MAX_STDERR_BYTES;

  if (
    typeof maxStderrBytes !== "number" ||
    !Number.isFinite(maxStderrBytes) ||
    maxStderrBytes <= 0 ||
    !Number.isInteger(maxStderrBytes)
  ) {
    throw new RequiredCommandRunnerError(
      "El límite de stderr debe ser un entero positivo.",
      { code: "INVALID_OUTPUT_LIMIT" },
    );
  }

  return { timeoutMs: runtime.timeoutMs, shellPath, maxStdoutBytes, maxStderrBytes };
}

function isCommandPassed(result: RequiredCommandProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    result.timedOut === false &&
    result.aborted === false &&
    result.signal === null
  );
}

function buildCommandResult(
  processResult: RequiredCommandProcessResult,
): RequiredCommandResult {
  return {
    command: processResult.command,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    durationMs: processResult.durationMs,
    timedOut: processResult.timedOut,
    aborted: processResult.aborted,
    stdoutTruncated: processResult.stdoutTruncated,
    stderrTruncated: processResult.stderrTruncated,
    passed: isCommandPassed(processResult),
  };
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ESRCH"
    ) {
      return;
    }

    try {
      child.kill(signal);
    } catch {
      // process may have already exited
    }
  }
}

function runDefaultCommand(
  input: RequiredCommandProcessInput,
): Promise<RequiredCommandProcessResult> {
  return new Promise<RequiredCommandProcessResult>((resolvePromise, rejectPromise) => {
    const startTime = performance.now();

    // If signal already aborted before starting, return immediately.
    if (input.signal?.aborted === true) {
      resolvePromise({
        command: input.command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: Math.max(0, performance.now() - startTime),
        timedOut: false,
        aborted: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    let timedOut = false;
    let aborted = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let signalHandler: (() => void) | null = null;
    let settled = false;
    let terminationRequested = false;
    let capturedExitCode: number | null = null;
    let capturedSignal: NodeJS.Signals | null = null;

    const child = spawn(input.shellPath, ["-c", input.command], {
      cwd: input.cwd,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutTotalBytes = 0;
    let stderrTotalBytes = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!stdoutTruncated) {
        stdoutTotalBytes += chunk.length;

        if (stdoutTotalBytes > input.maxStdoutBytes) {
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (!stderrTruncated) {
        stderrTotalBytes += chunk.length;

        if (stderrTotalBytes > input.maxStderrBytes) {
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
        }
      }
    });

    const cleanup = (): void => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }

      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }

      if (signalHandler !== null && input.signal !== undefined) {
        input.signal.removeEventListener("abort", signalHandler);
        signalHandler = null;
      }
    };

    const buildResult = (): RequiredCommandProcessResult => ({
      command: input.command,
      exitCode: capturedExitCode,
      signal: capturedSignal,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      durationMs: Math.max(0, performance.now() - startTime),
      timedOut,
      aborted,
      stdoutTruncated,
      stderrTruncated,
    });

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolvePromise(buildResult());
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      rejectPromise(error);
    };

    const requestTermination = (): void => {
      if (terminationRequested) {
        return;
      }

      terminationRequested = true;
      killProcessGroup(child, "SIGTERM");
      graceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, GRACE_PERIOD_MS);
    };

    // Capture exit code and signal on the 'exit' event.
    child.on("exit", (code, signal) => {
      capturedExitCode = code;
      capturedSignal = signal ?? null;
    });

    // Resolve on 'close' — fired after exit + streams close.
    child.on("close", () => {
      resolveOnce();
    });

    // Shell not found or spawn failure.
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        rejectOnce(
          new RequiredCommandRunnerError(
            `No se encontró el shell: ${input.shellPath}`,
            { code: "SHELL_NOT_FOUND", shellPath: input.shellPath, cause: error },
          ),
        );
        return;
      }

      rejectOnce(
        new RequiredCommandRunnerError(
          "No se pudo iniciar el proceso del comando.",
          { code: "SPAWN_FAILED", command: input.command, shellPath: input.shellPath, cause: error },
        ),
      );
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, input.timeoutMs);

    if (input.signal !== undefined) {
      signalHandler = () => {
        aborted = true;
        requestTermination();
      };

      input.signal.addEventListener("abort", signalHandler, { once: true });
    }
  });
}

export async function runRequiredCommands(
  workspacePath: string,
  commands: readonly string[],
  runtime: RequiredCommandRuntimeOptions,
  deps?: RequiredCommandRunnerDeps,
): Promise<RequiredCommandsExecutionResult> {
  validateWorkspacePath(workspacePath);
  const validatedRuntime = validateRuntime(runtime);

  if (!Array.isArray(commands)) {
    throw new RequiredCommandRunnerError(
      "Los comandos deben ser un array.",
      { code: "INVALID_COMMAND" },
    );
  }

  for (let i = 0; i < commands.length; i++) {
    validateCommand(commands[i], i);
  }

  if (commands.length === 0) {
    return { results: [], passed: true, stoppedAtIndex: null };
  }

  const runCommand = deps?.runCommand ?? runDefaultCommand;

  const results: RequiredCommandResult[] = [];
  let passed = true;
  let stoppedAtIndex: number | null = null;

  const preAborted = runtime.signal?.aborted === true;

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];

    let commandResult: RequiredCommandResult;

    if (preAborted) {
      commandResult = {
        command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        aborted: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        passed: false,
      };
    } else {
      const processInput: RequiredCommandProcessInput = {
        command,
        cwd: workspacePath,
        shellPath: validatedRuntime.shellPath,
        timeoutMs: validatedRuntime.timeoutMs,
        maxStdoutBytes: validatedRuntime.maxStdoutBytes,
        maxStderrBytes: validatedRuntime.maxStderrBytes,
        signal: runtime.signal,
      };

      const processResult = await runCommand(processInput);
      commandResult = buildCommandResult(processResult);
    }

    results.push(commandResult);

    if (!commandResult.passed) {
      passed = false;
      stoppedAtIndex = i;
      break;
    }
  }

  return { results, passed, stoppedAtIndex };
}
