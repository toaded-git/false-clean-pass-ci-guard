import { isConfiguredTestFile, isJavaScriptLikeFile, isPythonFile } from "../core/globs";
import type { Detector, DetectorContext, Finding, Severity } from "../core/types";
import { scanJavaScript } from "../parse/js-ast";

export const skippedTestsDetector: Detector = {
  id: "skipped-tests",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.skippedTests;
    if (!options.enabled) {
      return [];
    }

    const findings: Finding[] = [];
    const changedTestFiles = ctx.diff.filter((file) => file.status !== "removed" && isConfiguredTestFile(file.filename, ctx.config.testGlobs));

    for (const file of changedTestFiles) {
      const source = await ctx.readFile(file.filename);

      if (isPythonFile(file.filename)) {
        findings.push(...scanPythonSkips(source, file.filename, file.addedLines, options));
        continue;
      }

      if (!isJavaScriptLikeFile(file.filename)) {
        continue;
      }

      const scan = scanJavaScript(source);

      for (const signal of scan.testControls) {
        const isNew = file.addedLines.has(signal.line);
        const severity: Severity =
          signal.kind === "focus" ? "error" : isNew ? options.newSkipSeverity : options.legacySkipSeverity;

        findings.push({
          detector: skippedTestsDetector.id,
          severity,
          ruleId: "false-clean-pass/skipped-tests",
          file: file.filename,
          line: signal.line,
          evidence: signal.evidence,
          message: `${signal.name} ${isNew ? "was added in this diff" : "is present in a changed test file"}.`
        });
      }
    }

    return findings;
  }
};

function scanPythonSkips(
  source: string,
  filename: string,
  addedLines: Set<number>,
  options: {
    newSkipSeverity: Severity;
    legacySkipSeverity: Severity;
    pythonSkipifSilent: boolean;
  }
): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    const isSkip = /@(?:pytest\.mark\.)?skip(?:\(|$)|@unittest\.skip\(/.test(trimmed);
    const skipif = trimmed.match(/@(?:pytest\.mark\.)?skipif\((.*)\)/);
    if (!isSkip && !skipif) {
      return;
    }

    if (skipif && !options.pythonSkipifSilent && !hasPythonSkipReason(skipif[1] ?? "")) {
      return;
    }

    const isNew = addedLines.has(lineNumber);
    findings.push({
      detector: skippedTestsDetector.id,
      severity: isNew ? options.newSkipSeverity : options.legacySkipSeverity,
      ruleId: "false-clean-pass/skipped-tests",
      file: filename,
      line: lineNumber,
      evidence: trimmed,
      message:
        skipif && !hasPythonSkipReason(skipif[1] ?? "")
          ? "Python skipif has no reason and can silently hide tests."
          : `Python skip marker ${isNew ? "was added in this diff" : "is present in a changed test file"}.`
    });
  });

  return findings;
}

function hasPythonSkipReason(argumentText: string): boolean {
  return /\breason\s*=/.test(argumentText);
}
