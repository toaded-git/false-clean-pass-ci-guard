import { isTestFile } from "../core/globs";
import type { Detector, DetectorContext, Finding } from "../core/types";
import { scanJavaScript } from "../parse/js-ast";

export const emptyAssertionsDetector: Detector = {
  id: "empty-assertions",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.emptyAssertions;
    if (!options.enabled) {
      return [];
    }

    const findings: Finding[] = [];
    const changedTestFiles = ctx.diff.filter(
      (file) => file.status !== "removed" && isTestFile(file.filename, ctx.config.testGlobs)
    );

    for (const file of changedTestFiles) {
      const source = await ctx.readFile(file.filename);
      const scan = scanJavaScript(source, options.customAssertions, options.lenientAssertNames);

      for (const testCase of scan.testCases) {
        const isNew = file.addedLines.has(testCase.line);
        if (options.newTestsOnly && !isNew) {
          continue;
        }

        if (testCase.emptyBody || testCase.returnOnly) {
          findings.push({
            detector: emptyAssertionsDetector.id,
            severity: options.emptyBodySeverity,
            ruleId: "false-clean-pass/empty-test-body",
            file: file.filename,
            line: testCase.line,
            evidence: testCase.evidence,
            message: testCase.emptyBody
              ? "Test callback has an empty body."
              : "Test callback returns immediately without assertions."
          });
          continue;
        }

        if (testCase.assertionCount === 0) {
          findings.push({
            detector: emptyAssertionsDetector.id,
            severity: options.noAssertSeverity,
            ruleId: "false-clean-pass/no-assertions",
            file: file.filename,
            line: testCase.line,
            evidence: testCase.evidence,
            message: `Test callback has no assertion signals${isNew ? " and was added in this diff" : ""}.`
          });
        }
      }
    }

    return findings;
  }
};
