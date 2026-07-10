import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GuardConfig } from "../config/schema";
import type { DiffFile } from "../git/diff";
import type { DetectorContext } from "./types";

export function createDetectorContext(rootDir: string, config: GuardConfig, diff: DiffFile[]): DetectorContext {
  return {
    rootDir,
    config,
    diff,
    readFile(file: string) {
      return readFile(resolve(rootDir, file), "utf8");
    }
  };
}
