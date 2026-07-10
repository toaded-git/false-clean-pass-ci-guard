import type { GuardConfig } from "../config/schema";
import type { DiffFile } from "../git/diff";

export type Severity = "error" | "warning" | "info";
export type FailOn = "error" | "warning" | "never";

export interface Finding {
  detector: string;
  severity: Severity;
  ruleId: string;
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface DetectorContext {
  rootDir: string;
  config: GuardConfig;
  diff: DiffFile[];
  readFile(file: string): Promise<string>;
}

export interface Detector {
  id: string;
  run(ctx: DetectorContext): Promise<Finding[]>;
}

export interface RunResult {
  findings: Finding[];
  errorCount: number;
  warningCount: number;
  result: "pass" | "fail";
}
