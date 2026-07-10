import { readFileSync } from "node:fs";
import { loadConfig } from "./config/schema";
import { createDetectorContext } from "./core/context";
import { runGuard } from "./core/orchestrator";
import type { FailOn } from "./core/types";
import { getLocalGitDiff, parseUnifiedDiff } from "./git/diff";

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
  const config = loadConfig(rootDir, args.config ?? ".github/false-clean-pass.yml");
  const diff = args.diffFile
    ? parseUnifiedDiff(readFileSync(args.diffFile, "utf8"))
    : getLocalGitDiff(rootDir, args.base ?? "HEAD~1", args.head ?? "HEAD");
  const result = await runGuard(createDetectorContext(rootDir, config, diff), args.failOn ?? config.failOn);

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
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function parseFailOn(value: string): FailOn {
  if (value === "error" || value === "warning" || value === "never") {
    return value;
  }
  throw new Error(`Invalid --fail-on value: ${value}`);
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
