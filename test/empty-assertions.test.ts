import { describe, expect, it } from "vitest";
import { emptyAssertionsDetector } from "../src/detectors/empty-assertions";
import { contextFor, diffFile } from "./helpers";

describe("emptyAssertionsDetector", () => {
  it("reports no-assertion and empty-body tests", async () => {
    const file = "test/fixtures/empty-assert/src/noop.test.ts";
    const findings = await emptyAssertionsDetector.run(
      contextFor([
        diffFile(
          file,
          `@@ -1,0 +1,6 @@
+test("has no assertions", () => {
+  const value = 1 + 1;
+  console.log(value);
+});
+
+test("empty callback", () => {});
`
        )
      ])
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, severity: "warning", ruleId: "false-clean-pass/no-assertions" }),
        expect.objectContaining({ line: 6, severity: "error", ruleId: "false-clean-pass/empty-test-body" })
      ])
    );
  });

  it("counts chai should-style assertions", async () => {
    const file = "test/fixtures/chai/src/should.test.ts";
    const findings = await emptyAssertionsDetector.run(
      contextFor([
        diffFile(
          file,
          `@@ -1,0 +1,7 @@
+test("chai should assertion", () => {
+  result.should.equal(1);
+});
+
+test("chai should property assertion", () => {
+  result.should.exist;
+});
`
        )
      ])
    );

    expect(findings).toEqual([]);
  });
});
