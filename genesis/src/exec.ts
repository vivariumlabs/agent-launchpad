// The ONLY child_process user in genesis/src (hygiene-tested). oyster.ts shells the oyster-cvm CLI
// through the injected `Exec` interface so every invocation is mockable and recorded in tests.
// No shell: argv is passed verbatim (no interpolation / injection surface).

import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Exec {
  run(bin: string, args: readonly string[], opts: { timeoutMs: number }): Promise<ExecResult>;
}

const MAX_OUTPUT = 1024 * 1024;

export const nodeExec: Exec = {
  run(bin, args, opts) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
      });
      const done = (code: number | null, extra = ""): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr: stderr + extra, timedOut });
      };
      child.on("error", (e) => done(null, `\nspawn error: ${e.message}`));
      child.on("close", (code) => done(code));
    });
  },
};
