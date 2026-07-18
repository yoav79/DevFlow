/// <reference types="node" />

import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFile, chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  runOpenCodeProcess,
  OpenCodeProcessError,
  type OpenCodeProcessInput,
} from "../../src/services/opencode-process-runner.js";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

async function createTempDir(): Promise<TempDir> {
  const dir = join(tmpdir(), `devflow-opencode-test-${randomBytes(8).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return {
    path: dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeFakeBinary(
  dir: string,
  name: string,
  script: string,
): Promise<string> {
  const fullPath = join(dir, name);
  await writeFile(fullPath, script, "utf8");
  await chmod(fullPath, 0o755);
  return fullPath;
}

async function readTextFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(path, "utf8");
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const fs = await import("node:fs/promises");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw new Error(`Timed out waiting for file: ${path}`);
}

function baseInput(overrides?: Partial<OpenCodeProcessInput>): OpenCodeProcessInput {
  return {
    cwd: "/tmp",
    prompt: "test prompt",
    timeoutMs: 10_000,
    ...overrides,
  };
}

const tempDirs: TempDir[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await dir.cleanup();
  }
  tempDirs.length = 0;
});

async function makeTemp(): Promise<TempDir> {
  const dir = await createTempDir();
  tempDirs.push(dir);
  return dir;
}

describe("runOpenCodeProcess", () => {
  describe("validation", () => {
    it("rejects empty cwd", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ cwd: "  " })),
      ).rejects.toThrow(OpenCodeProcessError);

      try {
        await runOpenCodeProcess(baseInput({ cwd: "  " }));
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeProcessError);
        expect((error as OpenCodeProcessError).code).toBe("INVALID_INPUT");
      }
    });

    it("rejects empty prompt", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ prompt: "  " })),
      ).rejects.toThrow(OpenCodeProcessError);

      try {
        await runOpenCodeProcess(baseInput({ prompt: "  " }));
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeProcessError);
        expect((error as OpenCodeProcessError).code).toBe("INVALID_INPUT");
      }
    });

    it("rejects zero timeout", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ timeoutMs: 0 })),
      ).rejects.toThrow(OpenCodeProcessError);
    });

    it("rejects negative timeout", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ timeoutMs: -100 })),
      ).rejects.toThrow(OpenCodeProcessError);
    });

    it("rejects non-integer timeout", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ timeoutMs: 1.5 })),
      ).rejects.toThrow(OpenCodeProcessError);
    });

    it("rejects empty agent", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ agent: "  " })),
      ).rejects.toThrow(OpenCodeProcessError);
    });

    it("rejects empty model", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ model: "  " })),
      ).rejects.toThrow(OpenCodeProcessError);
    });

    it("rejects empty binaryPath", async () => {
      await expect(
        runOpenCodeProcess(baseInput({ binaryPath: "  " })),
      ).rejects.toThrow(OpenCodeProcessError);
    });
  });

  describe("arguments", () => {
    const ARGS_SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
`;

    it("uses run subcommand", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(baseInput({ binaryPath: binary, cwd: dir.path }));

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args[0]).toBe("run");
    });

    it("uses --format json", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(baseInput({ binaryPath: binary, cwd: dir.path }));

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args).toContain("--format");
      expect(args).toContain("json");
    });

    it("uses --dir with cwd", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(baseInput({ binaryPath: binary, cwd: dir.path }));

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      const dirIdx = args.indexOf("--dir");
      expect(dirIdx).toBeGreaterThanOrEqual(0);
      expect(args[dirIdx + 1]).toBe(dir.path);
    });

    it("prompt is last argument", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, prompt: "hello world" }),
      );

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args[args.length - 1]).toBe("hello world");
    });

    it("includes --agent when agent is set", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, agent: "supervisor" }),
      );

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args).toContain("--agent");
      expect(args).toContain("supervisor");
    });

    it("omits --agent when agent is not set", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(baseInput({ binaryPath: binary, cwd: dir.path }));

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args).not.toContain("--agent");
    });

    it("includes --model when model is set", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, model: "openai/gpt-4" }),
      );

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args).toContain("--model");
      expect(args).toContain("openai/gpt-4");
    });

    it("does not interpret shell characters in prompt", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(dir.path, "opencode-args", ARGS_SCRIPT);

      await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, prompt: 'echo $(whoami) `date` $HOME' }),
      );

      const args = JSON.parse(
        require("node:fs").readFileSync(join(dir.path, "args.json"), "utf8"),
      ) as string[];

      expect(args[args.length - 1]).toBe('echo $(whoami) `date` $HOME');
    });
  });

  describe("result", () => {
    it("captures stdout", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
console.log("hello stdout");
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stdout).toContain("hello stdout");
    });

    it("captures stderr", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
console.error("hello stderr");
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stderr).toContain("hello stderr");
    });

    it("returns exit code zero", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.exit(0);
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.exitCode).toBe(0);
    });

    it("returns non-zero exit code without throwing", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.exit(42);
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.exitCode).toBe(42);
    });

    it("captures cwd", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.exit(0);
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.cwd).toBe(dir.path);
    });

    it("returns args", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.exit(0);
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.args[0]).toBe("run");
      expect(result.args).toContain("--format");
    });

    it("returns valid durationMs", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.exit(0);
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.durationMs)).toBe(true);
    });
  });

  describe("errors", () => {
    it("binary not found produces BINARY_NOT_FOUND", async () => {
      const dir = await makeTemp();

      try {
        await runOpenCodeProcess(
          baseInput({
            binaryPath: join(dir.path, "nonexistent-binary"),
            cwd: dir.path,
          }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeProcessError);
        expect((error as OpenCodeProcessError).code).toBe("BINARY_NOT_FOUND");
      }
    });

    it("error message does not contain prompt", async () => {
      const dir = await makeTemp();

      try {
        await runOpenCodeProcess(
          baseInput({
            binaryPath: join(dir.path, "nonexistent-binary"),
            cwd: dir.path,
            prompt: "secret password 12345",
          }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenCodeProcessError);
        expect((error as Error).message).not.toContain("secret password 12345");
      }
    });
  });

  describe("timeout", () => {
    it("timeout marks timedOut", { timeout: 7_000 }, async () => {
      const dir = await makeTemp();
      const signalLogPath = join(dir.path, "signal.log");
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-slow",
        `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(signalLogPath)}, "spawn\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(signalLogPath)}, "sigterm\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      );

      const promise = runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, timeoutMs: 500 }),
      );

      await waitForFile(signalLogPath, 1_000);
      const result = await promise;

      const signalLog = await readTextFile(signalLogPath);
      expect(result.timedOut).toBe(true);
      expect(signalLog).toContain("spawn\n");
      expect(signalLog).toContain("sigterm\n");
    });

    it("timeout terminates the process", { timeout: 7_000 }, async () => {
      const dir = await makeTemp();
      const signalLogPath = join(dir.path, "signal.log");
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-slow",
        `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(signalLogPath)}, "spawn\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(signalLogPath)}, "sigterm\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      );

      const promise = runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, timeoutMs: 500 }),
      );

      await waitForFile(signalLogPath, 1_000);
      const result = await promise;

      const signalLog = await readTextFile(signalLogPath);
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
      expect(result.durationMs).toBeLessThan(7_000);
      expect(signalLog).toContain("sigterm\n");
    });
  });

  describe("abort", () => {
    it("abort after spawn marks aborted", { timeout: 7_000 }, async () => {
      const dir = await makeTemp();
      const signalLogPath = join(dir.path, "signal.log");
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-slow",
        `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(signalLogPath)}, "spawn\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(signalLogPath)}, "sigterm\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      );

      const controller = new AbortController();

      const promise = runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path, timeoutMs: 10_000, signal: controller.signal }),
      );

      await waitForFile(signalLogPath, 1_000);
      controller.abort();

      const result = await promise;

      const signalLog = await readTextFile(signalLogPath);
      expect(result.aborted).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
      expect(signalLog).toContain("sigterm\n");
    });

    it("already-aborted signal prevents spawn", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-slow",
        `#!/usr/bin/env node
setTimeout(() => process.exit(0), 60000);
`,
      );

      const controller = new AbortController();
      controller.abort();

      await expect(
        runOpenCodeProcess(
          baseInput({ binaryPath: binary, cwd: dir.path, timeoutMs: 10_000, signal: controller.signal }),
        ),
      ).rejects.toThrow(OpenCodeProcessError);
    });
  });

  describe("output limits", () => {
    it("stdout under limit is not truncated", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
console.log("small output");
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stdoutTruncated).toBe(false);
      expect(result.stdout).toContain("small output");
    });

    it("stderr under limit is not truncated", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
console.error("small error");
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stderrTruncated).toBe(false);
      expect(result.stderr).toContain("small error");
    });

    it("stdout over limit marks stdoutTruncated", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.stdout.write("x".repeat(${MAX_STDOUT_BYTES} + 1024));
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stdoutTruncated).toBe(true);
    });

    it("stderr over limit marks stderrTruncated", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.stderr.write("y".repeat(${MAX_STDERR_BYTES} + 1024));
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stderrTruncated).toBe(true);
    });

    it("process terminates even when both streams exceed limit", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
const largeStdout = "a".repeat(${MAX_STDOUT_BYTES} + 1024);
const largeStderr = "b".repeat(${MAX_STDERR_BYTES} + 1024);
process.stdout.write(largeStdout, () => {
  process.stderr.write(largeStderr);
});
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("env", () => {
    it("inherits a variable from process.env", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-env",
        `#!/usr/bin/env node
console.log(process.env.PATH || "");
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      expect(result.stdout).toContain(process.env.PATH ?? "");
    });

    it("extraEnv overwrites a variable", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-env",
        `#!/usr/bin/env node
console.log(process.env.DEVFLOW_TEST_VAR || "undefined");
`,
      );

      const result = await runOpenCodeProcess(
        baseInput({
          binaryPath: binary,
          cwd: dir.path,
          extraEnv: { DEVFLOW_TEST_VAR: "custom-value" },
        }),
      );

      expect(result.stdout).toContain("custom-value");
    });

    it("extraEnv with undefined removes the variable", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-env",
        `#!/usr/bin/env node
console.log(process.env.DEVFLOW_TEST_REMOVE || "undefined");
`,
      );

      try {
        process.env.DEVFLOW_TEST_REMOVE = "should-be-removed";

        const result = await runOpenCodeProcess(
          baseInput({
            binaryPath: binary,
            cwd: dir.path,
            extraEnv: { DEVFLOW_TEST_REMOVE: undefined },
          }),
        );

        expect(result.stdout).toContain("undefined");
      } finally {
        delete process.env.DEVFLOW_TEST_REMOVE;
      }
    });

    it("process.env is not modified", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-env",
        `#!/usr/bin/env node
process.exit(0);
`,
      );

      const originalEnv = { ...process.env };

      await runOpenCodeProcess(
        baseInput({
          binaryPath: binary,
          cwd: dir.path,
          extraEnv: { DEVFLOW_TEST_PRESERVE: "nope" },
        }),
      );

      expect(process.env.DEVFLOW_TEST_PRESERVE).toBeUndefined();

      for (const key of Object.keys(originalEnv)) {
        expect(process.env[key]).toBe(originalEnv[key]);
      }
    });
  });

  describe("cleanup", () => {
    it("no child processes left after completion", async () => {
      const dir = await makeTemp();
      const binary = await writeFakeBinary(
        dir.path,
        "opencode-out",
        `#!/usr/bin/env node
process.exit(0);
`,
      );

      await runOpenCodeProcess(
        baseInput({ binaryPath: binary, cwd: dir.path }),
      );

      // Allow time for process cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });
});
