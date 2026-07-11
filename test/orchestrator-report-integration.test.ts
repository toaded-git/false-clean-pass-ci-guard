import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGuard, shouldFail } from "../src/core/orchestrator";
import { createSarifLog } from "../src/report/sarif";
import { formatPullRequestComment } from "../src/report/comment";
import type { Finding } from "../src/core/types";
import { contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("milestone 3 orchestration and reports", () => {
  it("combines detector findings into one failing result, SARIF run, and PR summary", async () => {
    const root = makeVerifyTempDir("m3-");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, ".github"), { recursive: true });
    mkdirSync(join(root, "reports"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      `name: ci
jobs:
  test:
    steps:
      - run: npm test
        continue-on-error: true
`
    );
    writeFileSync(join(root, ".github/false-clean-pass-coverage.json"), JSON.stringify({ coverage: 70 }));
    writeFileSync(join(root, "reports/junit.xml"), `<testsuite tests="0" skipped="0"></testsuite>`);
    writeFileSync(join(root, "src/app.ts"), "const token = process.env.JWT_SECRET;\n");
    writeFileSync(join(root, "src/example.test.ts"), `test.only("focused", () => {});\n`);
    writeFileSync(join(root, "src/suppressed.ts"), "// eslint-disable-next-line no-console\nconsole.log('x');\n");

    const result = await runGuard(
      contextForRoot(
        root,
        [
          diffFile(
            ".github/workflows/ci.yml",
            `@@ -1,0 +1,2 @@
+      - run: npm test
+        continue-on-error: true
`
          ),
          diffFile(
            ".github/false-clean-pass-coverage.json",
            `@@ -1,1 +1,1 @@
-{"coverage":80}
+{"coverage":70}
`
          ),
          diffFile(
            "src/app.ts",
            `@@ -1,0 +1,1 @@
+const token = process.env.JWT_SECRET;
`
          ),
          diffFile(
            "src/example.test.ts",
            `@@ -1,0 +1,1 @@
+test.only("focused", () => {});
`
          ),
          diffFile(
            "src/suppressed.ts",
            `@@ -1,0 +1,2 @@
+// eslint-disable-next-line no-console
+console.log('x');
`
          )
        ],
        {
          detectors: {
            suppressionRatchet: {
              maxNewPerPR: 0
            }
          }
        },
        { testResultsGlob: "reports/*.xml" }
      )
    );

    const ruleIds = result.findings.map((finding) => finding.ruleId);
    const sarif = createSarifLog(result);
    const comment = formatPullRequestComment(result, "false-clean-pass.sarif");

    expect(result.result).toBe("fail");
    expect(ruleIds).toEqual(
      expect.arrayContaining([
        "false-clean-pass/continue-on-error",
        "false-clean-pass/baseline-change-unapproved",
        "false-clean-pass/env-missing",
        "false-clean-pass/skipped-tests",
        "false-clean-pass/empty-test-body",
        "false-clean-pass/new-suppression",
        "false-clean-pass/zero-tests"
      ])
    );
    expect(sarif.runs[0]?.results.map((item) => item.ruleId)).toEqual(expect.arrayContaining(ruleIds));
    expect(comment).toContain("| error |");
    expect(comment).toContain("false-clean-pass/zero-tests");
    rmSync(root, { recursive: true, force: true });
  });

  it("applies fail-on warning and never policies to the final result decision", () => {
    const findings: Finding[] = [
      {
        detector: "suppression-ratchet",
        severity: "warning",
        ruleId: "false-clean-pass/suppression-total-increase",
        message: "Suppression total increased."
      }
    ];

    expect(shouldFail(findings, "error")).toBe(false);
    expect(shouldFail(findings, "warning")).toBe(true);
    expect(shouldFail(findings, "never")).toBe(false);
  });
});
