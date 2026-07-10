import { resolve } from "node:path";
import type { Detector, DetectorContext, Finding } from "../core/types";

export const coverageRatchetDetector: Detector = {
  id: "coverage-ratchet",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.coverageRatchet;
    if (!options.enabled) {
      return [];
    }

    const findings: Finding[] = [];
    for (const file of ctx.diff) {
      findings.push(...scanThresholdDrops(file, options.thresholdDropSeverity));
    }

    if (ctx.coverageSummaryPath) {
      const measured = await readCoveragePercent(ctx, ctx.coverageSummaryPath);
      const baseline = await readCoveragePercent(ctx, options.baselineFile);
      if (measured === undefined) {
        findings.push({
          detector: coverageRatchetDetector.id,
          severity: "info",
          ruleId: "false-clean-pass/coverage-unreadable",
          file: ctx.coverageSummaryPath,
          message: "Coverage summary could not be read or did not contain a total percentage."
        });
      } else if (baseline === undefined) {
        findings.push({
          detector: coverageRatchetDetector.id,
          severity: "info",
          ruleId: "false-clean-pass/coverage-baseline-missing",
          file: options.baselineFile,
          message: "Coverage baseline is missing; create the baseline in a CODEOWNER-approved baseline update PR."
        });
      } else if (measured + options.tolerance < baseline) {
        findings.push({
          detector: coverageRatchetDetector.id,
          severity: "error",
          ruleId: "false-clean-pass/coverage-drop",
          file: ctx.coverageSummaryPath,
          message: `Measured coverage ${measured}% is below baseline ${baseline}% by more than ${options.tolerance} percentage points.`
        });
      }
    }

    return findings;
  }
};

function scanThresholdDrops(file: DetectorContext["diff"][number], severity: "error" | "warning" | "info"): Finding[] {
  if (!isCoverageConfigFile(file.filename)) {
    return [];
  }

  const removed = collectThresholds(file.removedLineContent);
  const added = collectThresholds(file.addedLineContent);
  const findings: Finding[] = [];

  for (const [key, oldValue] of removed.entries()) {
    const newValue = added.get(key);
    if (newValue === undefined || newValue >= oldValue) {
      continue;
    }

    findings.push({
      detector: coverageRatchetDetector.id,
      severity,
      ruleId: "false-clean-pass/coverage-threshold-drop",
      file: file.filename,
      message: `Coverage threshold ${key} decreased from ${oldValue} to ${newValue}.`
    });
  }

  return findings;
}

function collectThresholds(lines: Map<number, string>): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const content of lines.values()) {
    const match = content.match(/\b(lines|statements|branches|functions|fail_under)\b["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      thresholds.set(match[1]!.toLowerCase(), Number(match[2]));
      continue;
    }

    const coverageThreshold = content.match(/\bcoverageThreshold\b.*?(\d+(?:\.\d+)?)/i);
    if (coverageThreshold) {
      thresholds.set("coverageThreshold", Number(coverageThreshold[1]));
    }
  }
  return thresholds;
}

async function readCoveragePercent(ctx: DetectorContext, file: string): Promise<number | undefined> {
  if (!(await ctx.fileExists(file))) {
    return undefined;
  }

  try {
    const raw = await ctx.readFile(file);
    return extractCoveragePercent(JSON.parse(raw));
  } catch {
    try {
      const raw = await import("node:fs/promises").then((fs) => fs.readFile(resolve(ctx.rootDir, file), "utf8"));
      return extractCoveragePercent(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
}

function extractCoveragePercent(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const total = asRecord(record.total);
  const totalLines = asRecord(total?.lines);
  const totalStatements = asRecord(total?.statements);
  const candidates = [
    totalLines?.pct,
    totalStatements?.pct,
    record.coverage,
    record.lines,
    record.line,
    asRecord(record.total)?.pct
  ];

  for (const candidate of candidates) {
    const parsed = parseNumber(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isCoverageConfigFile(file: string): boolean {
  return /(^|\/)(jest|vitest)\.config\.[cm]?[jt]s$/.test(file) || /(^|\/)\.nycrc(?:\.json)?$/.test(file) || /(^|\/)pyproject\.toml$/.test(file);
}
