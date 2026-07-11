import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { presets } from "./presets";

const severitySchema = z.enum(["error", "warning", "info"]);
const failOnSchema = z.enum(["error", "warning", "never"]);

const skippedTestsSchema = z.object({
  enabled: z.boolean().optional(),
  onlyAlwaysError: z.boolean().optional(),
  newSkipSeverity: severitySchema.optional(),
  legacySkipSeverity: severitySchema.optional(),
  pythonSkipifSilent: z.boolean().optional()
});

const emptyAssertionsSchema = z.object({
  enabled: z.boolean().optional(),
  emptyBodySeverity: severitySchema.optional(),
  noAssertSeverity: severitySchema.optional(),
  customAssertions: z.array(z.string()).optional(),
  ignoreTodo: z.boolean().optional(),
  newTestsOnly: z.boolean().optional(),
  lenientAssertNames: z.boolean().optional()
});

const envMissingSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.array(z.string()).optional(),
  optional: z.array(z.string()).optional(),
  exampleFiles: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  knownProvided: z.array(z.string()).optional(),
  dynamicAccessSeverity: severitySchema.optional(),
  missingSeverity: severitySchema.optional(),
  exampleMissingCiSeverity: severitySchema.optional(),
  optionalSeverity: severitySchema.optional()
});

const ignoredFailuresSchema = z.object({
  enabled: z.boolean().optional(),
  newSeverity: severitySchema.optional(),
  legacySeverity: severitySchema.optional(),
  allowJobs: z.array(z.string()).optional(),
  allowContinueOnErrorSteps: z.array(z.string()).optional(),
  allowCleanupCommands: z.boolean().optional(),
  guardStepNames: z.array(z.string()).optional(),
  guardWeakeningSeverity: severitySchema.optional(),
  selfAttestation: z.boolean().optional()
});

const coverageRatchetSchema = z.object({
  enabled: z.boolean().optional(),
  thresholdDropSeverity: severitySchema.optional(),
  tolerance: z.number().min(0).optional(),
  baselineFile: z.string().optional()
});

const suppressionRatchetSchema = z.object({
  enabled: z.boolean().optional(),
  maxNewPerPR: z.number().int().min(0).optional(),
  totalIncreaseSeverity: severitySchema.optional(),
  requireReason: z.boolean().optional(),
  baselineFile: z.string().optional(),
  excludePaths: z.array(z.string()).optional()
});

const baselineGuardSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  changeSeverity: severitySchema.optional(),
  exemptLabel: z.string().optional(),
  allowInitialCreate: z.boolean().optional(),
  codeownerTeamFallback: z.boolean().optional()
});

const testCountRatchetSchema = z.object({
  enabled: z.boolean().optional(),
  maxDropPercent: z.number().min(0).max(100).optional(),
  skipRatioMax: z.number().min(0).max(1).optional(),
  baselineFile: z.string().optional()
});

const requiredJobSkipSchema = z.object({
  enabled: z.boolean().optional(),
  requiredJobs: z.array(z.string()).optional()
});

const detectorsSchema = z.object({
  skippedTests: skippedTestsSchema.optional(),
  emptyAssertions: emptyAssertionsSchema.optional(),
  envMissing: envMissingSchema.optional(),
  ignoredFailures: ignoredFailuresSchema.optional(),
  coverageRatchet: coverageRatchetSchema.optional(),
  suppressionRatchet: suppressionRatchetSchema.optional(),
  baselineGuard: baselineGuardSchema.optional(),
  requiredJobSkip: requiredJobSkipSchema.optional()
});

const configInputSchema = z
  .object({
    version: z.literal(1).optional(),
    preset: z.string().optional(),
    failOn: failOnSchema.optional(),
    testGlobs: z.array(z.string()).optional(),
    requiredJobs: z.array(z.string()).optional(),
    evidenceOutput: z.string().optional(),
    detectors: detectorsSchema.optional(),
    baselineGuard: baselineGuardSchema.optional(),
    testCountRatchet: testCountRatchetSchema.optional(),
    zeroTests: testCountRatchetSchema.optional()
  })
  .passthrough();

export type GuardConfigInput = z.input<typeof configInputSchema>;
export type SeverityConfig = z.infer<typeof severitySchema>;
export type GuardConfig = {
  version: 1;
  preset: string;
  failOn: "error" | "warning" | "never";
  testGlobs: string[];
  requiredJobs: string[];
  evidenceOutput: string;
  detectors: {
    skippedTests: {
      enabled: boolean;
      onlyAlwaysError: boolean;
      newSkipSeverity: SeverityConfig;
      legacySkipSeverity: SeverityConfig;
      pythonSkipifSilent: boolean;
    };
    emptyAssertions: {
      enabled: boolean;
      emptyBodySeverity: SeverityConfig;
      noAssertSeverity: SeverityConfig;
      customAssertions: string[];
      ignoreTodo: boolean;
      newTestsOnly: boolean;
      lenientAssertNames: boolean;
    };
    envMissing: {
      enabled: boolean;
      required: string[];
      optional: string[];
      exampleFiles: string[];
      ignore: string[];
      knownProvided: string[];
      dynamicAccessSeverity: SeverityConfig;
      missingSeverity: SeverityConfig;
      exampleMissingCiSeverity: SeverityConfig;
      optionalSeverity: SeverityConfig;
    };
    ignoredFailures: {
      enabled: boolean;
      newSeverity: SeverityConfig;
      legacySeverity: SeverityConfig;
      allowJobs: string[];
      allowContinueOnErrorSteps: string[];
      allowCleanupCommands: boolean;
      guardStepNames: string[];
      guardWeakeningSeverity: SeverityConfig;
      selfAttestation: boolean;
    };
    coverageRatchet: {
      enabled: boolean;
      thresholdDropSeverity: SeverityConfig;
      tolerance: number;
      baselineFile: string;
    };
    suppressionRatchet: {
      enabled: boolean;
      maxNewPerPR: number;
      totalIncreaseSeverity: SeverityConfig;
      requireReason: boolean;
      baselineFile: string;
      excludePaths: string[];
    };
    baselineGuard: {
      enabled: boolean;
      paths: string[];
      changeSeverity: SeverityConfig;
      exemptLabel: string;
      allowInitialCreate: boolean;
      codeownerTeamFallback: boolean;
    };
    requiredJobSkip: {
      enabled: boolean;
      requiredJobs: string[];
    };
  };
  baselineGuard: {
    enabled: boolean;
    paths: string[];
    changeSeverity: SeverityConfig;
    exemptLabel: string;
    allowInitialCreate: boolean;
    codeownerTeamFallback: boolean;
  };
  testCountRatchet: {
    enabled: boolean;
    maxDropPercent: number;
    skipRatioMax: number;
    baselineFile: string;
  };
};

export const defaultConfig: GuardConfig = {
  version: 1,
  preset: "node",
  failOn: "error",
  testGlobs: ["**/*.{test,spec}.{js,ts,jsx,tsx}", "tests/**/*_test.py", "**/test_*.py"],
  requiredJobs: [],
  evidenceOutput: "fcp-evidence.json",
  detectors: {
    skippedTests: {
      enabled: true,
      onlyAlwaysError: true,
      newSkipSeverity: "error",
      legacySkipSeverity: "warning",
      pythonSkipifSilent: true
    },
    emptyAssertions: {
      enabled: true,
      emptyBodySeverity: "error",
      noAssertSeverity: "warning",
      customAssertions: [],
      ignoreTodo: true,
      newTestsOnly: true,
      lenientAssertNames: true
    },
    envMissing: {
      enabled: true,
      required: [],
      optional: [],
      exampleFiles: [".env.example"],
      ignore: ["NODE_ENV", "CI", "PATH", "HOME", "PWD", "SHELL", "TMPDIR", "GITHUB_*", "RUNNER_*"],
      knownProvided: [],
      dynamicAccessSeverity: "info",
      missingSeverity: "error",
      exampleMissingCiSeverity: "warning",
      optionalSeverity: "info"
    },
    ignoredFailures: {
      enabled: true,
      newSeverity: "error",
      legacySeverity: "warning",
      allowJobs: ["experimental-nightly"],
      allowContinueOnErrorSteps: [],
      allowCleanupCommands: true,
      guardStepNames: ["false-clean-pass"],
      guardWeakeningSeverity: "error",
      selfAttestation: true
    },
    coverageRatchet: {
      enabled: true,
      thresholdDropSeverity: "error",
      tolerance: 0.5,
      baselineFile: ".github/false-clean-pass-coverage.json"
    },
    suppressionRatchet: {
      enabled: true,
      maxNewPerPR: 3,
      totalIncreaseSeverity: "warning",
      requireReason: true,
      baselineFile: ".github/false-clean-pass-suppressions.json",
      excludePaths: ["**/fixtures/**", "**/__mocks__/**", "node_modules/**", "build/**", "dist/**", ".git/**"]
    },
    baselineGuard: {
      enabled: true,
      paths: [".github/false-clean-pass-*.json"],
      changeSeverity: "error",
      exemptLabel: "baseline-update",
      allowInitialCreate: true,
      codeownerTeamFallback: false
    },
    requiredJobSkip: {
      enabled: true,
      requiredJobs: []
    }
  },
  baselineGuard: {
    enabled: true,
    paths: [".github/false-clean-pass-*.json"],
    changeSeverity: "error",
    exemptLabel: "baseline-update",
    allowInitialCreate: true,
    codeownerTeamFallback: false
  },
  testCountRatchet: {
    enabled: true,
    maxDropPercent: 20,
    skipRatioMax: 0.9,
    baselineFile: ".github/false-clean-pass-test-count.json"
  }
};

export function loadConfig(rootDir: string, configPath = ".github/false-clean-pass.yml"): GuardConfig {
  const absolutePath = resolve(rootDir, configPath);
  if (!existsSync(absolutePath)) {
    return defaultConfig;
  }

  const raw = readFileSync(absolutePath, "utf8");
  const parsedYaml = raw.trim().length > 0 ? parseYaml(raw) : {};
  const input = configInputSchema.parse(parsedYaml ?? {});
  const presetName = input.preset ?? defaultConfig.preset;
  const preset = presets[presetName] ?? {};

  return mergeConfig(defaultConfig, preset, input);
}

export function mergeConfig(...parts: GuardConfigInput[]): GuardConfig {
  const merged = parts.reduce<GuardConfigInput>((acc, part) => deepMerge(acc, part), {});
  const parsed = configInputSchema.parse(merged);
  const topLevelBaselineGuard = parsed.baselineGuard ?? parsed.detectors?.baselineGuard;
  const testCountRatchet = parsed.testCountRatchet ?? parsed.zeroTests;

  const config: GuardConfig = {
    version: 1,
    preset: parsed.preset ?? defaultConfig.preset,
    failOn: parsed.failOn ?? defaultConfig.failOn,
    testGlobs: parsed.testGlobs ?? defaultConfig.testGlobs,
    requiredJobs: parsed.requiredJobs ?? defaultConfig.requiredJobs,
    evidenceOutput: parsed.evidenceOutput ?? defaultConfig.evidenceOutput,
    detectors: {
      skippedTests: {
        ...defaultConfig.detectors.skippedTests,
        ...parsed.detectors?.skippedTests
      },
      emptyAssertions: {
        ...defaultConfig.detectors.emptyAssertions,
        ...parsed.detectors?.emptyAssertions,
        customAssertions:
          parsed.detectors?.emptyAssertions?.customAssertions ??
          defaultConfig.detectors.emptyAssertions.customAssertions
      },
      envMissing: {
        ...defaultConfig.detectors.envMissing,
        ...parsed.detectors?.envMissing,
        required: parsed.detectors?.envMissing?.required ?? defaultConfig.detectors.envMissing.required,
        optional: parsed.detectors?.envMissing?.optional ?? defaultConfig.detectors.envMissing.optional,
        exampleFiles: parsed.detectors?.envMissing?.exampleFiles ?? defaultConfig.detectors.envMissing.exampleFiles,
        ignore: parsed.detectors?.envMissing?.ignore ?? defaultConfig.detectors.envMissing.ignore,
        knownProvided: parsed.detectors?.envMissing?.knownProvided ?? defaultConfig.detectors.envMissing.knownProvided
      },
      ignoredFailures: {
        ...defaultConfig.detectors.ignoredFailures,
        ...parsed.detectors?.ignoredFailures,
        allowJobs: parsed.detectors?.ignoredFailures?.allowJobs ?? defaultConfig.detectors.ignoredFailures.allowJobs,
        allowContinueOnErrorSteps:
          parsed.detectors?.ignoredFailures?.allowContinueOnErrorSteps ??
          defaultConfig.detectors.ignoredFailures.allowContinueOnErrorSteps,
        guardStepNames:
          parsed.detectors?.ignoredFailures?.guardStepNames ?? defaultConfig.detectors.ignoredFailures.guardStepNames
      },
      coverageRatchet: {
        ...defaultConfig.detectors.coverageRatchet,
        ...parsed.detectors?.coverageRatchet
      },
      suppressionRatchet: {
        ...defaultConfig.detectors.suppressionRatchet,
        ...parsed.detectors?.suppressionRatchet,
        excludePaths:
          parsed.detectors?.suppressionRatchet?.excludePaths ?? defaultConfig.detectors.suppressionRatchet.excludePaths
      },
      baselineGuard: {
        ...defaultConfig.detectors.baselineGuard,
        ...topLevelBaselineGuard,
        paths: topLevelBaselineGuard?.paths ?? defaultConfig.detectors.baselineGuard.paths
      },
      requiredJobSkip: {
        ...defaultConfig.detectors.requiredJobSkip,
        ...parsed.detectors?.requiredJobSkip,
        requiredJobs:
          parsed.detectors?.requiredJobSkip?.requiredJobs ??
          parsed.requiredJobs ??
          defaultConfig.detectors.requiredJobSkip.requiredJobs
      }
    },
    baselineGuard: {
      ...defaultConfig.baselineGuard,
      ...topLevelBaselineGuard,
      paths: topLevelBaselineGuard?.paths ?? defaultConfig.baselineGuard.paths
    },
    testCountRatchet: {
      ...defaultConfig.testCountRatchet,
      ...testCountRatchet
    }
  };

  config.detectors.baselineGuard = config.baselineGuard;
  return config;
}

function deepMerge(left: GuardConfigInput, right: GuardConfigInput): GuardConfigInput {
  if (!right) {
    return left;
  }

  return {
    ...left,
    ...right,
    detectors: {
      ...left.detectors,
      ...right.detectors,
      skippedTests: {
        ...left.detectors?.skippedTests,
        ...right.detectors?.skippedTests
      },
      emptyAssertions: {
        ...left.detectors?.emptyAssertions,
        ...right.detectors?.emptyAssertions
      },
      envMissing: {
        ...left.detectors?.envMissing,
        ...right.detectors?.envMissing
      },
      ignoredFailures: {
        ...left.detectors?.ignoredFailures,
        ...right.detectors?.ignoredFailures
      },
      coverageRatchet: {
        ...left.detectors?.coverageRatchet,
        ...right.detectors?.coverageRatchet
      },
      suppressionRatchet: {
        ...left.detectors?.suppressionRatchet,
        ...right.detectors?.suppressionRatchet
      },
      baselineGuard: {
        ...left.detectors?.baselineGuard,
        ...right.detectors?.baselineGuard
      },
      requiredJobSkip: {
        ...left.detectors?.requiredJobSkip,
        ...right.detectors?.requiredJobSkip
      }
    },
    baselineGuard: {
      ...left.baselineGuard,
      ...right.baselineGuard
    },
    testCountRatchet: {
      ...left.testCountRatchet,
      ...right.testCountRatchet
    },
    zeroTests: {
      ...left.zeroTests,
      ...right.zeroTests
    }
  };
}
