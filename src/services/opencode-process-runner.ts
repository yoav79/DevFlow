/// <reference types="node" />

import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;
const DEFAULT_BINARY = "opencode";
const GRACE_PERIOD_MS = 3000;

export interface OpenCodeProcessInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly agent?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly binaryPath?: string;
  readonly extraEnv?: Readonly<Record<string, string | undefined>>;
}

export interface OpenCodeProcessResult {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
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

export type OpenCodeProcessErrorCode =
  | "INVALID_INPUT"
  | "BINARY_NOT_FOUND"
  | "SPAWN_FAILED";

export class OpenCodeProcessError extends Error {
  readonly code: OpenCodeProcessErrorCode;
  readonly binaryPath: string;
  readonly cwd: string;

  constructor(
    message: string,
    options: {
      code: OpenCodeProcessErrorCode;
      binaryPath: string;
      cwd: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "OpenCodeProcessError";
    this.code = options.code;
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function validateInput(input: OpenCodeProcessInput): {
  binary: string;
  resolvedCwd: string;
  prompt: string;
} {
  const resolvedCwd = input.cwd.trim();

  if (resolvedCwd.length === 0) {
    throw new OpenCodeProcessError(
      "El directorio de trabajo no puede estar vacío.",
      { code: "INVALID_INPUT", binaryPath: "opencode", cwd: input.cwd },
    );
  }

  const prompt = input.prompt.trim();

  if (prompt.length === 0) {
    throw new OpenCodeProcessError(
      "El prompt no puede estar vacío.",
      { code: "INVALID_INPUT", binaryPath: "opencode", cwd: resolvedCwd },
    );
  }

  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || !Number.isInteger(input.timeoutMs)) {
    throw new OpenCodeProcessError(
      "El timeout debe ser un entero positivo.",
      { code: "INVALID_INPUT", binaryPath: "opencode", cwd: resolvedCwd },
    );
  }

  if (input.agent !== undefined && input.agent.trim().length === 0) {
    throw new OpenCodeProcessError(
      "El agente no puede estar vacío.",
      { code: "INVALID_INPUT", binaryPath: "opencode", cwd: resolvedCwd },
    );
  }

  if (input.model !== undefined && input.model.trim().length === 0) {
    throw new OpenCodeProcessError(
      "El modelo no puede estar vacío.",
      { code: "INVALID_INPUT", binaryPath: "opencode", cwd: resolvedCwd },
    );
  }

  const binary = (input.binaryPath ?? DEFAULT_BINARY).trim();

  if (binary.length === 0) {
    throw new OpenCodeProcessError(
      "El path del binario no puede estar vacío.",
      { code: "INVALID_INPUT", binaryPath: binary, cwd: resolvedCwd },
    );
  }

  return { binary, resolvedCwd, prompt };
}

function buildArgs(cwd: string, prompt: string, agent?: string, model?: string): string[] {
  const args = ["run", "--format", "json", "--dir", cwd];

  if (agent !== undefined) {
    args.push("--agent", agent);
  }

  if (model !== undefined) {
    args.push("--model", model);
  }

  args.push(prompt);

  return args;
}

function buildEnv(extraEnv?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  if (extraEnv === undefined) {
    return { ...process.env };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

export async function runOpenCodeProcess(
  input: OpenCodeProcessInput,
): Promise<OpenCodeProcessResult> {
  const { binary, resolvedCwd, prompt } = validateInput(input);

  if (input.signal !== undefined && input.signal.aborted) {
    throw new OpenCodeProcessError(
      "La señal de abort ya estaba activa antes de ejecutar el proceso.",
      { code: "INVALID_INPUT", binaryPath: binary, cwd: resolvedCwd, cause: input.signal.reason },
    );
  }

  const args = buildArgs(resolvedCwd, prompt, input.agent, input.model);
  const env = buildEnv(input.extraEnv);
  const startTime = performance.now();

  const child = spawn(binary, args, {
    cwd: resolvedCwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
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

      if (stdoutTotalBytes > MAX_STDOUT_BYTES) {
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (!stderrTruncated) {
      stderrTotalBytes += chunk.length;

      if (stderrTotalBytes > MAX_STDERR_BYTES) {
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
      }
    }
  });

  let timedOut = false;
  let aborted = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let signalHandler: (() => void) | null = null;
  let settled = false;
  let terminationRequested = false;

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

  const buildResult = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): OpenCodeProcessResult => ({
    binaryPath: binary,
    args,
    cwd: resolvedCwd,
    exitCode,
    signal,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    durationMs: Math.max(0, performance.now() - startTime),
    timedOut,
    aborted,
    stdoutTruncated,
    stderrTruncated,
  });

  const killProcess = (sig: NodeJS.Signals = "SIGTERM"): void => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig);
      } catch {
        // process may have already exited
      }
    }
  };

  const result = await new Promise<OpenCodeProcessResult>((resolvePromise, rejectPromise) => {
    const resolveOnce = (value: OpenCodeProcessResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolvePromise(value);
    };

    const rejectOnce = (error: OpenCodeProcessError): void => {
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
      killProcess("SIGTERM");
      graceTimer = setTimeout(() => {
        killProcess("SIGKILL");
      }, GRACE_PERIOD_MS);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | undefined): void => {
      resolveOnce(buildResult(code, signal ?? null));
    };

    child.on("close", onClose);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        rejectOnce(
          new OpenCodeProcessError(
            `No se encontró el binario de OpenCode: ${binary}`,
            { code: "BINARY_NOT_FOUND", binaryPath: binary, cwd: resolvedCwd, cause: error },
          ),
        );
        return;
      }

      rejectOnce(
        new OpenCodeProcessError(
          "No se pudo iniciar el proceso de OpenCode.",
          { code: "SPAWN_FAILED", binaryPath: binary, cwd: resolvedCwd, cause: error },
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

  return result;
}
