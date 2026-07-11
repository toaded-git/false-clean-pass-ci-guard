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
  metadata?: Record<string, unknown>;
}

export interface GitHubRuntime {
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  baseSha?: string;
  actor?: string;
  runId?: string;
  baseRef?: string;
  pullNumber?: number;
}

export interface PullRequestReview {
  user: string;
  state: string;
  submittedAt?: string;
  authorAssociation?: string;
}

export interface CodeOwnerReviewProvider {
  listReviews(): Promise<PullRequestReview[]>;
  isTeamMember?(teamOwner: string, teamSlug: string, username: string): Promise<boolean | undefined>;
}

export interface CheckRunAttestationResult {
  ok: boolean;
  reason?: "missing" | "sha-mismatch" | "api-failed";
  message?: string;
}

export type CheckRunAttestationVerifier = () => Promise<CheckRunAttestationResult>;

export interface DetectorContext {
  rootDir: string;
  config: GuardConfig;
  diff: DiffFile[];
  ciEnvKeys: Set<string>;
  testResultsGlob?: string;
  baseTestResultsGlob?: string;
  coverageSummaryPath?: string;
  prLabels: string[];
  github?: GitHubRuntime;
  codeOwnerReviewProvider?: CodeOwnerReviewProvider;
  checkRunAttestationVerifier?: CheckRunAttestationVerifier;
  readFile(file: string): Promise<string>;
  readBaseFile?(file: string): Promise<string>;
  fileExists(file: string): Promise<boolean>;
  listFiles(): Promise<string[]>;
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
