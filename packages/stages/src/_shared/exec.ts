import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a shell command in `cwd`. Returns stdout/stderr/exitCode; never throws.
 * Timeout defaults to 60 seconds.
 */
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...env },
        shell: false,
      },
      (err, stdout, stderr) => {
        const exitCode = (err as NodeJS.ErrnoException & { code?: number })?.code
          ? 1
          : child.exitCode ?? (err ? 1 : 0);
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode,
        });
      },
    );
  });
}

/** Convenience: run via the user's shell so PATH, aliases, etc. work. */
export function sh(command: string, cwd: string, timeoutMs = 60_000): Promise<ExecResult> {
  return run("/bin/sh", ["-c", command], cwd, timeoutMs);
}
