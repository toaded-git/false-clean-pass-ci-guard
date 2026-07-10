import { emptyAssertionsDetector } from "../detectors/empty-assertions";
import { skippedTestsDetector } from "../detectors/skipped-tests";
import { suppressionRatchetDetector } from "../detectors/suppression-ratchet";
import { scanJavaScript } from "../parse/js-ast";
import { isTestFile } from "./globs";
import type { FailOn, Detector, DetectorContext, Finding, RunResult } from "./types";

export const milestone1Detectors: Detector[] = [
  skippedTestsDetector,
  emptyAssertionsDetector,
  suppressionRatchetDetector
];

export async function runGuard(ctx: DetectorContext, failOn: FailOn = ctx.config.failOn): Promise<RunResult> {
  const findings: Finding[] = await detectParseFailures(ctx);

  for (const detector of milestone1Detectors) {
    findings.push(...(await detector.run(ctx)));
  }

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;

  return {
    findings,
    errorCount,
    warningCount,
    result: shouldFail(findings, failOn) ? "fail" : "pass"
  };
}

async function detectParseFailures(ctx: DetectorContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const changedTestFiles = ctx.diff.filter(
    (file) => file.status !== "removed" && isTestFile(file.filename, ctx.config.testGlobs)
  );

  for (const file of changedTestFiles) {
    if (seen.has(file.filename)) {
      continue;
    }
    seen.add(file.filename);

    const scan = scanJavaScript(await ctx.readFile(file.filename));
    if (!scan.parseFailed) {
      continue;
    }

    findings.push({
      detector: "orchestrator",
      severity: "info",
      ruleId: "false-clean-pass/parse-failed",
      file: file.filename,
      message: `Changed test file could not be parsed; AST-based detectors skipped it. ${scan.parseError ?? ""}`.trim()
    });
  }

  return findings;
}

export function shouldFail(findings: Finding[], failOn: FailOn): boolean {
  if (failOn === "never") {
    return false;
  }
  if (failOn === "warning") {
    return findings.some((finding) => finding.severity === "error" || finding.severity === "warning");
  }
  return findings.some((finding) => finding.severity === "error");
}
