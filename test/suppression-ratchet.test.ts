import { describe, expect, it } from "vitest";
import { suppressionRatchetDetector } from "../src/detectors/suppression-ratchet";
import { contextFor, diffFile } from "./helpers";

describe("suppressionRatchetDetector", () => {
  it("reports newly added suppression comments when maxNewPerPR is exceeded", async () => {
    const file = "test/fixtures/suppressions/src/suppressed.ts";
    const findings = await suppressionRatchetDetector.run(
      contextFor([
        diffFile(
          file,
          `@@ -1,2 +1,3 @@
 const value = 1;
+// eslint-disable-next-line no-console
 console.log(value);
`
        )
      ])
    );

    expect(findings).toEqual([
      expect.objectContaining({
        line: 2,
        severity: "error",
        ruleId: "false-clean-pass/new-suppression"
      })
    ]);
  });

  it("does not scan repository-wide suppression totals in milestone 1", async () => {
    const file = "test/fixtures/suppressions/src/suppressed.ts";
    const findings = await suppressionRatchetDetector.run(
      contextFor([
        diffFile(
          file,
          `@@ -1,3 +1,3 @@
 const value = 1;
 // eslint-disable-next-line no-console
 console.log(value);
`
        )
      ])
    );

    expect(findings).toEqual([]);
  });
});
