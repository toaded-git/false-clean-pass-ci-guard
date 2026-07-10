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

export const nextPreset: GuardConfigInput = {
  ...nodePreset,
  testGlobs: ["**/*.{test,spec}.{js,ts,jsx,tsx}", "app/**/*.{test,spec}.{js,ts,jsx,tsx}"]
};

export const pythonPreset: GuardConfigInput = {
  testGlobs: ["tests/**/*_test.py", "**/test_*.py"],
  detectors: {
    skippedTests: {
      enabled: true
    },
    envMissing: {
      enabled: true
    },
    suppressionRatchet: {
      enabled: true
    }
  }
};

export const presets: Record<string, GuardConfigInput> = {
  none: {},
  node: nodePreset,
  next: nextPreset,
  python: pythonPreset
};
