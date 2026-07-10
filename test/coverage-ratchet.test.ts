import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageRatchetDetector } from "../src/detectors/coverage-ratchet";
import { contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("coverageRatchetDetector", () => {
  it("reports coverage threshold decreases", async () => {
    const root = makeVerifyTempDir("coverage-");
    const findings = await coverageRatchetDetector.run(
      contextForRoot(root, [
        diffFile(
          "vitest.config.ts",
          `@@ -1,2 +1,2 @@
-        lines: 80
+        lines: 70
`
        )
      ])
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/coverage-threshold-drop"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports measured coverage below baseline beyond tolerance", async () => {
    const root = makeVerifyTempDir("coverage-");
    mkdirSync(join(root, ".github"), { recursive: true });
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(join(root, ".github/false-clean-pass-coverage.json"), JSON.stringify({ coverage: 85 }));
    writeFileSync(
      join(root, "coverage/coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 80 } } })
    );

    const findings = await coverageRatchetDetector.run(
      contextForRoot(root, [], {}, { coverageSummaryPath: "coverage/coverage-summary.json" })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/coverage-drop"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});
