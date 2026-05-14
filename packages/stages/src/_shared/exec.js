import { execFile } from "node:child_process";
/**
 * Run a shell command in `cwd`. Returns stdout/stderr/exitCode; never throws.
 * Timeout defaults to 60 seconds.
 */
export function run(cmd, args, cwd, timeoutMs = 60_000, env) {
    return new Promise((resolve) => {
        const child = execFile(cmd, args, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, ...env },
            shell: false,
        }, (err, stdout, stderr) => {
            const exitCode = err?.code
                ? 1
                : child.exitCode ?? (err ? 1 : 0);
            resolve({
                stdout: typeof stdout === "string" ? stdout : "",
                stderr: typeof stderr === "string" ? stderr : "",
                exitCode,
            });
        });
    });
}
/** Convenience: run via the user's shell so PATH, aliases, etc. work. */
export function sh(command, cwd, timeoutMs = 60_000) {
    return run("/bin/sh", ["-c", command], cwd, timeoutMs);
}
