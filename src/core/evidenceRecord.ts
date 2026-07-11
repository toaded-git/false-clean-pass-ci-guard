import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Finding, RunResult } from "./types";

export type EvidenceRecordVerdict = "pass" | "fail";
export type EvidenceAttemptKind =
  | "required_job_missing"
  | "required_job_if_skip_risk"
  | "required_job_if_added_review"
  | "required_workflow_trigger_narrowed"
  | "required_config_narrowed";
export type EvidenceWeakeningKind =
  | "mapping_unresolved"
  | "suppression_increase"
  | "run_count_drop"
  | "guard_weakening"
  | "ignored_failure"
  | "baseline_change"
  | "coverage_drop"
  | "env_missing"
  | "test_skip"
  | "empty_assertion"
  | "parse_failure"
  | "other";

export interface EvidenceAttempt {
  kind: EvidenceAttemptKind;
  severity: "high" | "review";
  target: string;
  detail: string;
  file?: string;
  line?: number;
  baseValue?: string | null;
  headValue?: string | null;
}

export interface EvidenceWeakening {
  kind: EvidenceWeakeningKind;
  severity: "high" | "medium" | "low";
  target?: string;
  detail: string;
  file?: string;
  line?: number;
  delta?: number;
  baseline?: number;
  current?: number;
}

export interface EvidenceRecord {
  schemaVersion: "1.0";
  repo: string;
  prNumber: number | null;
  headSha: string;
  baseSha: string | null;
  actor: string;
  runId: string | null;
  timestamp: string;
  verdict: EvidenceRecordVerdict;
  attempts: EvidenceAttempt[];
  weakenings: EvidenceWeakening[];
  detectorSummary: {
    total: number;
    failed: number;
    review: number;
    passed: number;
  };
  license: {
    org: false;
    licenseId: null;
    signaturePresent: false;
  };
  signature: null;
}

export interface EvidenceRecordInput {
  result: RunResult;
  repo: string;
  prNumber?: number | null;
  headSha: string;
  baseSha?: string | null;
  actor?: string;
  runId?: string | number | null;
  timestamp?: string;
}

interface EvidenceMetadata {
  recordSection: "attempts" | "weakenings";
  kind: string;
  severity: string;
  target?: string;
  detail: string;
  file?: string;
  line?: number;
  baseValue?: string | null;
  headValue?: string | null;
  delta?: number;
  baseline?: number;
  current?: number;
}

export function createEvidenceRecord(input: EvidenceRecordInput): EvidenceRecord {
  const attempts = input.result.findings.flatMap((finding) => findingToAttempt(finding));
  const weakenings = input.result.findings.flatMap((finding) => findingToWeakening(finding));
  const reviewCount = attempts.filter((attempt) => attempt.severity === "review").length;

  return {
    schemaVersion: "1.0",
    repo: input.repo,
    prNumber: input.prNumber ?? null,
    headSha: input.headSha,
    baseSha: input.baseSha ?? null,
    actor: input.actor ?? "unknown",
    runId: input.runId === undefined || input.runId === null ? null : String(input.runId),
    timestamp: input.timestamp ?? new Date().toISOString(),
    verdict: input.result.result,
    attempts,
    weakenings,
    detectorSummary: {
      total: input.result.findings.length,
      failed: input.result.errorCount,
      review: reviewCount,
      passed: 0
    },
    license: {
      org: false,
      licenseId: null,
      signaturePresent: false
    },
    signature: null
  };
}

export async function writeEvidenceRecord(record: EvidenceRecord, outputPath: string, rootDir = process.cwd()): Promise<string> {
  const absolutePath = resolve(rootDir, outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return absolutePath;
}

function findingToAttempt(finding: Finding): EvidenceAttempt[] {
  const metadata = evidenceMetadata(finding);
  if (metadata?.recordSection !== "attempts") {
    return [];
  }

  return [
    {
      kind: metadata.kind as EvidenceAttemptKind,
      severity: metadata.severity === "review" ? "review" : "high",
      target: metadata.target ?? finding.file ?? finding.ruleId,
      detail: metadata.detail,
      file: metadata.file ?? finding.file,
      line: metadata.line ?? finding.line,
      baseValue: metadata.baseValue,
      headValue: metadata.headValue
    }
  ];
}

function findingToWeakening(finding: Finding): EvidenceWeakening[] {
  const metadata = evidenceMetadata(finding);
  if (metadata?.recordSection === "weakenings") {
    return [
      {
        kind: metadata.kind as EvidenceWeakeningKind,
        severity: metadata.severity === "high" || metadata.severity === "low" ? metadata.severity : "medium",
        target: metadata.target,
        detail: metadata.detail,
        file: metadata.file ?? finding.file,
        line: metadata.line ?? finding.line,
        delta: metadata.delta,
        baseline: metadata.baseline,
        current: metadata.current
      }
    ];
  }

  if (metadata?.recordSection === "attempts" || finding.severity === "info") {
    return [];
  }

  return [
    {
      kind: classifyWeakeningKind(finding),
      severity: finding.severity === "error" ? "high" : "medium",
      target: finding.file,
      detail: finding.message,
      file: finding.file,
      line: finding.line
    }
  ];
}

function evidenceMetadata(finding: Finding): EvidenceMetadata | undefined {
  const metadata = finding.metadata?.evidenceRecord;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return metadata as EvidenceMetadata;
}

function classifyWeakeningKind(finding: Finding): EvidenceWeakeningKind {
  if (finding.ruleId.includes("suppression")) {
    return "suppression_increase";
  }
  if (finding.ruleId.includes("test-count") || finding.ruleId.includes("zero-tests")) {
    return "run_count_drop";
  }
  if (finding.ruleId.includes("guard") || finding.ruleId.includes("required-list") || finding.ruleId.includes("fail-on")) {
    return "guard_weakening";
  }
  if (finding.ruleId.includes("continue-on-error") || finding.ruleId.includes("ignore-failure")) {
    return "ignored_failure";
  }
  if (finding.ruleId.includes("baseline-change")) {
    return "baseline_change";
  }
  if (finding.ruleId.includes("coverage")) {
    return "coverage_drop";
  }
  if (finding.ruleId.includes("env-")) {
    return "env_missing";
  }
  if (finding.ruleId.includes("skipped-tests")) {
    return "test_skip";
  }
  if (finding.ruleId.includes("empty-test") || finding.ruleId.includes("no-assertions")) {
    return "empty_assertion";
  }
  if (finding.ruleId.includes("parse-failed")) {
    return "parse_failure";
  }
  return "other";
}
