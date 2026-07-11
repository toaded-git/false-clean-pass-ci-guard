import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testCountRatchetDetector } from "../src/detectors/test-count-ratchet";
import { contextForRoot, makeVerifyTempDir } from "./helpers";

describe("testCountRatchetDetector", () => {
  it("warns when no test result files match the configured glob", async () => {
    const root = makeVerifyTempDir("test-count-");

    const findings = await testCountRatchetDetector.run(
      contextForRoot(root, [], {}, { testResultsGlob: "reports/*.xml" })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        ruleId: "false-clean-pass/test-results-missing"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when a matched JUnit XML file is malformed", async () => {
    const root = makeVerifyTempDir("test-count-");
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports/junit.xml"), `<testsuite tests= <<< broken`);

    const findings = await testCountRatchetDetector.run(
      contextForRoot(root, [], {}, { testResultsGlob: "reports/*.xml" })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/test-results-invalid",
        file: "reports/junit.xml"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("hard-fails when JUnit reports zero executed tests", async () => {
    const root = makeVerifyTempDir("test-count-");
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports/junit.xml"), `<testsuite tests="0" skipped="0"></testsuite>`);

    const findings = await testCountRatchetDetector.run(
      contextForRoot(root, [], {}, { testResultsGlob: "reports/*.xml" })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/zero-tests"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports 210 to 40 executed test count drops beyond maxDropPercent", async () => {
    const root = makeVerifyTempDir("test-count-");
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports/current.xml"), `<testsuite tests="40" skipped="0"></testsuite>`);
    writeFileSync(join(root, "reports/base.xml"), `<testsuite tests="210" skipped="0"></testsuite>`);

    const findings = await testCountRatchetDetector.run(
      contextForRoot(root, [], {}, { testResultsGlob: "reports/current.xml", baseTestResultsGlob: "reports/base.xml" })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/test-count-drop",
        message: expect.stringContaining("Review required")
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when the executed test count baseline is intentionally updated", async () => {
    const root = makeVerifyTempDir("test-count-");
    mkdirSync(join(root, ".github"), { recursive: true });
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, ".github/false-clean-pass-test-count.json"), JSON.stringify({ executed: 40 }));
    writeFileSync(join(root, "reports/current.xml"), `<testsuite tests="40" skipped="0"></testsuite>`);

    const findings = await testCountRatchetDetector.run(
      contextForRoot(root, [], {}, { testResultsGlob: "reports/current.xml" })
    );

    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
