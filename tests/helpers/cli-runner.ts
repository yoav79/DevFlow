/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliOptions {
  home: string;
  cwd?: string;
}

export function runCli(args: string[], options: RunCliOptions): CliResult {
  const cliPath = resolve(import.meta.dirname, "../../dist/cli.js");
  const result = spawnSync("node", [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...process.env, HOME: options.home },
  });

  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar el CLI: ${result.error.message}`);
  }

  const exitCode = result.status ?? 1;
  const stdout = result.stdout.replace(/\n$/, "");
  const stderr = result.stderr.replace(/\n$/, "");

  return { stdout, stderr, exitCode };
}
