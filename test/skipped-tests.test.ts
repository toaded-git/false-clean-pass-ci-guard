import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skippedTestsDetector } from "../src/detectors/skipped-tests";
import { contextFor, contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("skippedTestsDetector", () => {
  it("classifies focus tests as errors even when they are legacy lines", async () => {
    const file = "test/fixtures/skips/src/focused.test.ts";
    const findings = await skippedTestsDetector.run(
      contextFor([
        diffFile(
          file,
          `@@ -1,4 +1,7 @@
 test.only("legacy focus", () => {
   expect(1).toBe(1);
 });
 
+it.only("new focus", () => {
+  expect(2).toBe(2);
+});
`
        )
      ])
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, severity: "error", ruleId: "false-clean-pass/skipped-tests" }),
        expect.objectContaining({ line: 5, severity: "error", ruleId: "false-clean-pass/skipped-tests" })
      ])
    );
  });

  it("reports Python skipif without a reason by default", async () => {
    const root = makeVerifyTempDir("skips-");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests/test_example.py"),
      `import pytest

@pytest.mark.skipif(True)
def test_skipped():
    assert True
`
    );

    const findings = await skippedTestsDetector.run(
      contextForRoot(root, [
        diffFile(
          "tests/test_example.py",
          `@@ -1,0 +1,5 @@
+import pytest
+
+@pytest.mark.skipif(True)
+def test_skipped():
+    assert True
`
        )
      ])
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/skipped-tests",
        line: 3
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});
