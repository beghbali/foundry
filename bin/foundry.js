#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliEntrypoint = resolve(repoRoot, "apps/cli/src/index.ts");
const tsxBinary = resolve(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

if (!existsSync(tsxBinary)) {
  console.error("Foundry launcher could not find the local tsx binary.");
  console.error(`Expected: ${tsxBinary}`);
  console.error("Run `npm install` in the Foundry repo, then try again.");
  process.exit(1);
}

const child = spawn(tsxBinary, [cliEntrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Foundry launcher failed: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
