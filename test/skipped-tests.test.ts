import { describe, expect, it } from "vitest";
import { skippedTestsDetector } from "../src/detectors/skipped-tests";
import { contextFor, diffFile } from "./helpers";

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
});
