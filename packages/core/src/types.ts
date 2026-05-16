import type { z } from "zod";

import type { FoundryConfig } from "./config.js";

/** Logger used by stages and runner (no console assumptions). */
export type Logger = (message: string, meta?: Record<string, unknown>) => void;

/**
 * Runtime context for a single pipeline run.
 * Artifact paths for readArtifact/writeArtifact are relative to `outDir`
 * (i.e. `.foundry/out/<runId>/`).
 */
export interface RunContext {
  repoPath: string;
  runId: string;
  /** Absolute path: `<repo>/.foundry/out/<runId>` */
  outDir: string;
  config: FoundryConfig;
  logger: Logger;
  /** Read a UTF-8 file under this run's output directory. */
  readArtifact: (relativePath: string) => Promise<string | undefined>;
  /** Write a UTF-8 file under this run's output directory (creates parent dirs). */
  writeArtifact: (relativePath: string, data: string) => Promise<void>;
  /** Returns the 0-based pipeline index for a stage name (used by artifact helpers for sort-order prefixes). */
  stageIndex?: (stageName: string) => number;
}

export interface Stage<I, O> {
  name: string;
  description?: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  run(ctx: RunContext, input: I): Promise<O>;
}

export type StageStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface StageResult {
  stage: string;
  status: StageStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  /** True when output was restored from `.foundry/.pipeline-stage-cache.json` (no new work). */
  reused?: boolean;
  /**
   * Optional structured note about why a stage was skipped. Used by the runner
   * to distinguish, e.g., a convergence-gate skip (worth retrying via refinement
   * loop because the contract can self-evolve) from a release-readiness-gate
   * skip (needs Cursor to close the brief first — refinement won't help).
   */
  skipCause?: "builder" | "qa" | "convergence" | "release_readiness" | "directives_unaddressed";
}

export interface RunManifest {
  runId: string;
  repoPath: string;
  pipeline: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  stages: StageResult[];
}
