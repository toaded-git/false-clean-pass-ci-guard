import { isTestFile } from "../core/globs";
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
    const changedTestFiles = ctx.diff.filter(
      (file) => file.status !== "removed" && isTestFile(file.filename, ctx.config.testGlobs)
    );

    for (const file of changedTestFiles) {
      const source = await ctx.readFile(file.filename);
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
