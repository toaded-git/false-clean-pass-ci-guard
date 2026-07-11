import { matchesAnyGlob } from "../core/globs";
import type { Detector, DetectorContext, Finding } from "../core/types";

const suppressionPatterns = [
  /\beslint-disable(?:-(?:next-line|line))?\b/,
  /@ts-ignore\b/,
  /@ts-expect-error\b/,
  /#\s*type:\s*ignore\b/,
  /#\s*noqa\b/,
  /#\s*pylint:\s*disable\b/
];

interface SuppressionHit {
  file: string;
  line: number;
  evidence: string;
}

export const suppressionRatchetDetector: Detector = {
  id: "suppression-ratchet",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.suppressionRatchet;
    if (!options.enabled) {
      return [];
    }

    const newSuppressions = collectNewSuppressions(ctx);
    const findings: Finding[] =
      newSuppressions.length > options.maxNewPerPR
        ? newSuppressions.map((hit): Finding => ({
            detector: suppressionRatchetDetector.id,
            severity: "error",
            ruleId: "false-clean-pass/new-suppression",
            file: hit.file,
            line: hit.line,
            evidence: hit.evidence.trim(),
            message: `New suppression comment exceeds maxNewPerPR=${options.maxNewPerPR} (${newSuppressions.length} added).`
          }))
        : [];

    const baselineTotal = await readSuppressionBaseline(ctx, options.baselineFile);
    if (baselineTotal !== undefined) {
      const currentTotal = await countRepositorySuppressions(ctx);
      if (currentTotal > baselineTotal) {
        findings.push({
          detector: suppressionRatchetDetector.id,
          severity: options.totalIncreaseSeverity,
          ruleId: "false-clean-pass/suppression-total-increase",
          file: options.baselineFile,
          message: `Suppression comment total increased from baseline ${baselineTotal} to ${currentTotal}.`
        });
      }
    }

    return findings;
  }
};

function collectNewSuppressions(ctx: DetectorContext): SuppressionHit[] {
  const hits: SuppressionHit[] = [];
  const options = ctx.config.detectors.suppressionRatchet;

  for (const file of ctx.diff) {
    if (file.status === "removed") {
      continue;
    }

    for (const [line, content] of file.addedLineContent.entries()) {
      if (
        suppressionPatterns.some((pattern) => pattern.test(content)) &&
        !(options.requireReason && suppressionHasValidReason(content))
      ) {
        hits.push({
          file: file.filename,
          line,
          evidence: content
        });
      }
    }
  }

  return hits;
}

async function countRepositorySuppressions(ctx: DetectorContext): Promise<number> {
  const options = ctx.config.detectors.suppressionRatchet;
  const files = (await ctx.listFiles()).filter((file) => !matchesAnyGlob(file, options.excludePaths));
  let total = 0;

  for (const file of files) {
    if (!isSuppressionScanFile(file)) {
      continue;
    }
    let source: string;
    try {
      source = await ctx.readFile(file);
    } catch {
      continue;
    }

    for (const line of source.split(/\r?\n/)) {
      if (suppressionPatterns.some((pattern) => pattern.test(line))) {
        total += 1;
      }
    }
  }

  return total;
}

async function readSuppressionBaseline(ctx: DetectorContext, file: string): Promise<number | undefined> {
  if (!(await ctx.fileExists(file))) {
    return undefined;
  }
  try {
    const json = JSON.parse(await ctx.readFile(file)) as unknown;
    return extractBaselineTotal(json);
  } catch {
    return undefined;
  }
}

function extractBaselineTotal(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["total", "count", "suppressions"]) {
    const parsed = numberFromUnknown(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const nested = record.suppressions;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return numberFromUnknown((nested as Record<string, unknown>).total);
  }
  return undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function suppressionHasValidReason(line: string): boolean {
  const reason = extractSuppressionReason(line);
  if (!reason) {
    return false;
  }

  const normalized = reason.trim();
  return normalized.length >= 8 && !/^(?:auto|todo|fixme|n\/a|none)$/i.test(normalized);
}

function extractSuppressionReason(line: string): string | undefined {
  const separated = line.match(/\s--\s*(.+)$/);
  if (separated?.[1]) {
    return separated[1];
  }

  const tsDirective = line.match(/@ts-(?:expect-error|ignore)\b(?::|\s+)\s*(.+)$/);
  if (tsDirective?.[1]) {
    return tsDirective[1];
  }

  const noqa = line.match(/#\s*noqa:\s*(.+)$/);
  return noqa?.[1];
}

function isSuppressionScanFile(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|mjs|cjs|ts|tsx)$/.test(file);
}
