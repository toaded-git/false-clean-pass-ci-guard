import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema";

describe("default config reconciliation", () => {
  it("matches the current M1 guard defaults", () => {
    expect(defaultConfig.detectors.suppressionRatchet.maxNewPerPR).toBe(3);
    expect(defaultConfig.detectors.suppressionRatchet.requireReason).toBe(true);
    expect(defaultConfig.detectors.emptyAssertions.newTestsOnly).toBe(true);
    expect(defaultConfig.detectors.emptyAssertions.lenientAssertNames).toBe(true);
    expect(defaultConfig.detectors.skippedTests.pythonSkipifSilent).toBe(true);
    expect(defaultConfig.detectors.envMissing.missingSeverity).toBe("error");
  });
});
