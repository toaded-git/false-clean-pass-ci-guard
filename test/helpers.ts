import { resolve } from "node:path";
import { defaultConfig, mergeConfig, type GuardConfigInput } from "../src/config/schema";
import { createDetectorContext } from "../src/core/context";
import type { DetectorContext } from "../src/core/types";
import { parsePatch, type DiffFile } from "../src/git/diff";

export const repoRoot = resolve(process.cwd());

export function diffFile(filename: string, patch: string): DiffFile {
  return parsePatch(filename, patch);
}

export function contextFor(diff: DiffFile[], override: GuardConfigInput = {}): DetectorContext {
  return createDetectorContext(repoRoot, mergeConfig(defaultConfig, override), diff);
}
