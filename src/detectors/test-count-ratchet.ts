import { matchesAnyGlob } from "../core/globs";
import type { Detector, DetectorContext, Finding } from "../core/types";
import { addTestCountSummaries, parseJUnitXml, type TestCountSummary } from "../parse/junit";

interface TestResultsReadResult {
  summary?: TestCountSummary;
  parseErrors: Array<{ file: string; message: string }>;
}

export const testCountRatchetDetector: Detector = {
  id: "test-count-ratchet",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.testCountRatchet;
    if (!options.enabled || !ctx.testResultsGlob) {
      return [];
    }

    const findings: Finding[] = [];
    const current = await readTestResults(ctx, ctx.testResultsGlob);
    findings.push(...parseErrorFindings(current.parseErrors));
    if (!current.summary) {
      if (current.parseErrors.length > 0) {
        return findings;
      }
      return [
        {
          detector: testCountRatchetDetector.id,
          severity: "warning",
          ruleId: "false-clean-pass/test-results-missing",
          message: `No test result files matched test-results-glob=${ctx.testResultsGlob}.`
        }
      ];
    }

    const currentSummary = current.summary;
    if (currentSummary.executed === 0) {
      findings.push({
        detector: testCountRatchetDetector.id,
        severity: "error",
        ruleId: "false-clean-pass/zero-tests",
        message: "JUnit results report 0 executed tests; a green CI run with no executed tests is blocked."
      });
      return findings;
    }

    if (currentSummary.tests > 0 && currentSummary.skipped / currentSummary.tests > options.skipRatioMax) {
      findings.push({
        detector: testCountRatchetDetector.id,
        severity: "warning",
        ruleId: "false-clean-pass/high-skip-ratio",
        message: `JUnit results skipped ${currentSummary.skipped}/${currentSummary.tests} tests, above skipRatioMax=${options.skipRatioMax}.`
      });
    }

    let base: TestCountSummary | undefined;
    if (ctx.baseTestResultsGlob) {
      const baseResults = await readTestResults(ctx, ctx.baseTestResultsGlob);
      findings.push(...parseErrorFindings(baseResults.parseErrors));
      base = baseResults.summary;
    } else {
      base = await readBaselineTestCount(ctx, options.baselineFile);
    }

    if (base?.executed && base.executed > 0) {
      const dropPercent = ((base.executed - currentSummary.executed) / base.executed) * 100;
      if (dropPercent > options.maxDropPercent) {
        findings.push({
          detector: testCountRatchetDetector.id,
          severity: "error",
          ruleId: "false-clean-pass/test-count-drop",
          file: ctx.testResultsGlob,
          message: `Executed test count dropped from ${base.executed} to ${currentSummary.executed} (${dropPercent.toFixed(
            1
          )}%), above maxDropPercent=${options.maxDropPercent}.`
        });
      }
    }

    return findings;
  }
};

async function readTestResults(ctx: DetectorContext, glob: string): Promise<TestResultsReadResult> {
  const patterns = glob
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const files = (await ctx.listFiles()).filter((file) => matchesAnyGlob(file, patterns));
  if (files.length === 0) {
    return { parseErrors: [] };
  }

  const summaries: TestCountSummary[] = [];
  const parseErrors: Array<{ file: string; message: string }> = [];
  for (const file of files) {
    try {
      const source = await ctx.readFile(file);
      summaries.push(parseJUnitXml(source));
    } catch (error: unknown) {
      parseErrors.push({
        file,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    summary: summaries.length > 0 ? addTestCountSummaries(summaries) : undefined,
    parseErrors
  };
}

function parseErrorFindings(parseErrors: Array<{ file: string; message: string }>): Finding[] {
  return parseErrors.map((error) => ({
    detector: testCountRatchetDetector.id,
    severity: "error",
    ruleId: "false-clean-pass/test-results-invalid",
    file: error.file,
    message: `Test result file exists but could not be parsed as JUnit XML: ${error.message}`
  }));
}

async function readBaselineTestCount(ctx: DetectorContext, file: string): Promise<TestCountSummary | undefined> {
  if (!(await ctx.fileExists(file))) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await ctx.readFile(file)) as unknown;
    const executed = extractExecuted(parsed);
    return executed === undefined
      ? undefined
      : {
          tests: executed,
          skipped: 0,
          failures: 0,
          errors: 0,
          executed
        };
  } catch {
    return undefined;
  }
}

function extractExecuted(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["executed", "testCount", "count", "tests"]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  return undefined;
}
