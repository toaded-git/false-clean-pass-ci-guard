import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GuardConfig } from "../config/schema";
import type { DiffFile } from "../git/diff";
import type { CheckRunAttestationVerifier, CodeOwnerReviewProvider, DetectorContext, GitHubRuntime } from "./types";

export interface DetectorContextOptions {
  ciEnvKeys?: Iterable<string>;
  testResultsGlob?: string;
  baseTestResultsGlob?: string;
  coverageSummaryPath?: string;
  prLabels?: string[];
  github?: GitHubRuntime;
  codeOwnerReviewProvider?: CodeOwnerReviewProvider;
  checkRunAttestationVerifier?: CheckRunAttestationVerifier;
  readBaseFile?: (file: string) => Promise<string>;
  listFiles?: () => Promise<string[]>;
}

export function createDetectorContext(
  rootDir: string,
  config: GuardConfig,
  diff: DiffFile[],
  options: DetectorContextOptions = {}
): DetectorContext {
  return {
    rootDir,
    config,
    diff,
    ciEnvKeys: new Set([...(options.ciEnvKeys ?? [])].map((key) => key.trim()).filter(Boolean)),
    testResultsGlob: options.testResultsGlob,
    baseTestResultsGlob: options.baseTestResultsGlob,
    coverageSummaryPath: options.coverageSummaryPath,
    prLabels: options.prLabels ?? [],
    github: options.github,
    codeOwnerReviewProvider: options.codeOwnerReviewProvider,
    checkRunAttestationVerifier: options.checkRunAttestationVerifier,
    readFile(file: string) {
      return readFile(resolve(rootDir, file), "utf8");
    },
    readBaseFile: options.readBaseFile,
    async fileExists(file: string) {
      try {
        await stat(resolve(rootDir, file));
        return true;
      } catch {
        return false;
      }
    },
    listFiles() {
      return options.listFiles ? options.listFiles() : listRepositoryFiles(rootDir);
    }
  };
}

async function listRepositoryFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  await walk(rootDir, "", files);
  return files;
}

async function walk(rootDir: string, relativeDir: string, files: string[]): Promise<void> {
  const absoluteDir = resolve(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isIgnoredDirectory(relativePath)) {
        continue;
      }
      await walk(rootDir, relativePath, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

function isIgnoredDirectory(relativePath: string): boolean {
  return [".git", "node_modules", "build", "dist", ".verify-tmp"].some(
    (dir) => relativePath === dir || relativePath.startsWith(`${dir}/`)
  );
}
