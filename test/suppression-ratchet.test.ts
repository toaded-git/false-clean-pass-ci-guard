import { describe, expect, it } from "vitest";
import { suppressionRatchetDetector } from "../src/detectors/suppression-ratchet";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextFor, contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("suppressionRatchetDetector", () => {
  it("reports newly added suppression comments when maxNewPerPR is exceeded", async () => {
    const file = "test/fixtures/suppressions/src/suppressed.ts";
    const findings = await suppressionRatchetDetector.run(
      contextFor(
        [
          diffFile(
            file,
            `@@ -1,2 +1,3 @@
 const value = 1;
+// eslint-disable-next-line no-console
 console.log(value);
`
          )
        ],
        { detectors: { suppressionRatchet: { maxNewPerPR: 0 } } }
      )
    );

    expect(findings).toEqual([
      expect.objectContaining({
        line: 2,
        severity: "error",
        ruleId: "false-clean-pass/new-suppression"
      })
    ]);
  });

  it("does not report repository-wide suppression totals when no baseline exists", async () => {
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

  it("reports repository-wide suppression total increases over baseline", async () => {
    const root = makeVerifyTempDir("suppressions-");
    mkdirSync(join(root, ".github"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".github/false-clean-pass-suppressions.json"), JSON.stringify({ total: 0 }));
    writeFileSync(join(root, "src/example.ts"), "// eslint-disable-next-line no-console\nconsole.log('x');\n");

    const findings = await suppressionRatchetDetector.run(contextForRoot(root, []));

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        ruleId: "false-clean-pass/suppression-total-increase"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});
