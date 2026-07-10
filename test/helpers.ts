import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig, mergeConfig, type GuardConfigInput } from "../src/config/schema";
import { createDetectorContext, type DetectorContextOptions } from "../src/core/context";
import type { DetectorContext } from "../src/core/types";
import { parsePatch, type DiffFile } from "../src/git/diff";

export const repoRoot = resolve(process.cwd());
export const verifyTmpRoot = resolve(repoRoot, ".verify-tmp");

export function diffFile(filename: string, patch: string): DiffFile {
  return parsePatch(filename, patch);
}

export function contextFor(diff: DiffFile[], override: GuardConfigInput = {}): DetectorContext {
  return createDetectorContext(repoRoot, mergeConfig(defaultConfig, override), diff);
}

export function contextForRoot(
  rootDir: string,
  diff: DiffFile[],
  override: GuardConfigInput = {},
  options: DetectorContextOptions = {}
): DetectorContext {
  return createDetectorContext(rootDir, mergeConfig(defaultConfig, override), diff, options);
}

export function makeVerifyTempDir(prefix: string): string {
  mkdirSync(verifyTmpRoot, { recursive: true });
  return mkdtempSync(resolve(verifyTmpRoot, prefix));
}
