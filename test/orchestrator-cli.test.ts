import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { runGuard } from "../src/core/orchestrator";
import { contextFor, diffFile } from "./helpers";

describe("milestone 1 orchestration", () => {
  it("returns no findings for the clean fixture", async () => {
    const file = "test/fixtures/clean/src/example.test.ts";
    const result = await runGuard(
      contextFor([
        diffFile(
          file,
          `@@ -1,0 +1,3 @@
+test("adds numbers", () => {
+  expect(1 + 1).toBe(2);
+});
`
        )
      ])
    );

    expect(result).toMatchObject({
      result: "pass",
      errorCount: 0,
      warningCount: 0
    });
    expect(result.findings).toEqual([]);
  });

  it("surfaces parse failures as info findings and continues running detectors", async () => {
    const brokenFile = "test/fixtures/parse-failed/src/broken.test.ts";
    const focusedFile = "test/fixtures/skips/src/focused.test.ts";
    const result = await runGuard(
      contextFor([
        diffFile(
          brokenFile,
          `@@ -1,0 +1,3 @@
+test.only("broken focus", () => {
+  expect(1).toBe(
+});
`
        ),
        diffFile(
          focusedFile,
          `@@ -1,3 +1,4 @@
 test.only("legacy focus", () => {
+  expect(0).toBe(0);
   expect(1).toBe(1);
 });
`
        )
      ])
    );

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "orchestrator",
          severity: "info",
          ruleId: "false-clean-pass/parse-failed",
          file: brokenFile
        }),
        expect.objectContaining({
          detector: "skipped-tests",
          severity: "error",
          ruleId: "false-clean-pass/skipped-tests",
          file: focusedFile,
          line: 1
        })
      ])
    );
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("returns a non-zero CLI code when fail-on=error sees an error finding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "false-clean-pass-"));
    const diffPath = join(dir, "change.patch");
    writeFileSync(
      diffPath,
      `diff --git a/test/fixtures/suppressions/src/suppressed.ts b/test/fixtures/suppressions/src/suppressed.ts
index 1111111..2222222 100644
--- a/test/fixtures/suppressions/src/suppressed.ts
+++ b/test/fixtures/suppressions/src/suppressed.ts
@@ -1,2 +1,3 @@
 const value = 1;
+// eslint-disable-next-line no-console
 console.log(value);
`
    );
    let output = "";

    const code = await runCli(["--root", process.cwd(), "--diff-file", diffPath, "--fail-on", "error"], {
      stdout: { write: (chunk: string) => ((output += chunk), true) },
      stderr: { write: () => true }
    });

    expect(code).toBe(1);
    expect(output).toContain("false-clean-pass fail");
  });
});
