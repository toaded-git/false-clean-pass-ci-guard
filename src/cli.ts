import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, type GuardConfig } from "./config/schema";
import { createDetectorContext } from "./core/context";
import { createEvidenceRecord, writeEvidenceRecord } from "./core/evidenceRecord";
import { runGuard } from "./core/orchestrator";
import type { FailOn } from "./core/types";
import { getLocalGitDiff, parseUnifiedDiff } from "./git/diff";
import { writeSarifLogFile } from "./report/sarif";

export interface CliStreams {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runCli(
  argv: string[],
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  const args = parseArgs(argv);
  const rootDir = args.root ?? process.cwd();
  const config = applyCliConfigOverrides(loadConfig(rootDir, args.config ?? ".github/false-clean-pass.yml"), args);
  const diff = args.diffFile
    ? parseUnifiedDiff(readFileSync(args.diffFile, "utf8"))
    : getLocalGitDiff(rootDir, args.base ?? "HEAD~1", args.head ?? "HEAD");
  const result = await runGuard(
    createDetectorContext(rootDir, config, diff, {
      ciEnvKeys: args.ciEnvKeys,
      testResultsGlob: args.testResultsGlob,
      baseTestResultsGlob: args.baseTestResultsGlob,
      coverageSummaryPath: args.coverageSummary,
      prLabels: args.prLabels,
      readBaseFile: createLocalBaseFileReader(rootDir, args.base ?? "HEAD~1")
    }),
    args.failOn ?? config.failOn
  );

  if (args.sarifPath) {
    await writeSarifLogFile(result, { rootDir, sarifPath: args.sarifPath });
  }

  if (args.evidenceOutput) {
    await writeEvidenceRecord(
      createEvidenceRecord({
        result,
        repo: "local/local",
        prNumber: null,
        headSha: args.head ?? "HEAD",
        baseSha: args.base ?? null,
        actor: "local",
        runId: null
      }),
      args.evidenceOutput,
      rootDir
    );
  }

  if (args.json) {
    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    streams.stdout.write(
      `false-clean-pass ${result.result}: ${result.errorCount} errors, ${result.warningCount} warnings, ${result.findings.length} findings\n`
    );
  }

  return result.result === "fail" ? 1 : 0;
}

interface CliArgs {
  root?: string;
  config?: string;
  diffFile?: string;
  base?: string;
  head?: string;
  failOn?: FailOn;
  ciEnvKeys?: string[];
  testResultsGlob?: string;
  baseTestResultsGlob?: string;
  testCountBaseline?: string;
  coverageSummary?: string;
  sarifPath?: string;
  evidenceOutput?: string;
  prLabels?: string[];
  requiredJobs?: string[];
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--root" && value) {
      args.root = value;
      index += 1;
    } else if (arg === "--config" && value) {
      args.config = value;
      index += 1;
    } else if (arg === "--diff-file" && value) {
      args.diffFile = value;
      index += 1;
    } else if (arg === "--base" && value) {
      args.base = value;
      index += 1;
    } else if (arg === "--head" && value) {
      args.head = value;
      index += 1;
    } else if (arg === "--fail-on" && value) {
      args.failOn = parseFailOn(value);
      index += 1;
    } else if (arg === "--ci-env-keys" && value) {
      args.ciEnvKeys = splitCommaList(value);
      index += 1;
    } else if (arg === "--test-results-glob" && value) {
      args.testResultsGlob = value;
      index += 1;
    } else if (arg === "--base-test-results-glob" && value) {
      args.baseTestResultsGlob = value;
      index += 1;
    } else if (arg === "--test-count-baseline" && value) {
      args.testCountBaseline = value;
      index += 1;
    } else if (arg === "--coverage-summary" && value) {
      args.coverageSummary = value;
      index += 1;
    } else if (arg === "--sarif-path" && value) {
      args.sarifPath = value;
      index += 1;
    } else if (arg === "--evidence-output" && value) {
      args.evidenceOutput = value;
      index += 1;
    } else if (arg === "--required-jobs" && value) {
      args.requiredJobs = splitCommaList(value);
      index += 1;
    } else if (arg === "--pr-label" && value) {
      args.prLabels = [...(args.prLabels ?? []), value];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFailOn(value: string): FailOn {
  if (value === "error" || value === "warning" || value === "never") {
    return value;
  }
  throw new Error(`Invalid --fail-on value: ${value}`);
}

function applyCliConfigOverrides(config: GuardConfig, args: CliArgs): GuardConfig {
  let next = config;

  if (args.testCountBaseline) {
    next = {
      ...next,
      testCountRatchet: {
        ...next.testCountRatchet,
        baselineFile: args.testCountBaseline
      }
    };
  }

  if (args.requiredJobs && args.requiredJobs.length > 0) {
    next = {
      ...next,
      requiredJobs: args.requiredJobs,
      detectors: {
        ...next.detectors,
        requiredJobSkip: {
          ...next.detectors.requiredJobSkip,
          requiredJobs: args.requiredJobs
        }
      }
    };
  }

  if (args.evidenceOutput) {
    next = {
      ...next,
      evidenceOutput: args.evidenceOutput
    };
  }

  return next;
}

function createLocalBaseFileReader(rootDir: string, base: string): (file: string) => Promise<string> {
  return async (file: string) =>
    execFileSync("git", ["show", `${base}:${file}`], {
      cwd: rootDir,
      encoding: "utf8"
    });
}

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    });
}
