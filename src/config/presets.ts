import type { GuardConfigInput } from "./schema";

export const nodePreset: GuardConfigInput = {
  testGlobs: ["**/*.{test,spec}.{js,ts,jsx,tsx}"],
  detectors: {
    skippedTests: {
      enabled: true
    },
    emptyAssertions: {
      enabled: true
    },
    suppressionRatchet: {
      enabled: true
    }
  }
};

export const presets: Record<string, GuardConfigInput> = {
  none: {},
  node: nodePreset
};
