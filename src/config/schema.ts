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
  legacySkipSeverity: severitySchema.optional()
});

const emptyAssertionsSchema = z.object({
  enabled: z.boolean().optional(),
  emptyBodySeverity: severitySchema.optional(),
  noAssertSeverity: severitySchema.optional(),
  customAssertions: z.array(z.string()).optional(),
  ignoreTodo: z.boolean().optional()
});

const suppressionRatchetSchema = z.object({
  enabled: z.boolean().optional(),
  maxNewPerPR: z.number().int().min(0).optional()
});

const configInputSchema = z
  .object({
    version: z.literal(1).optional(),
    preset: z.string().optional(),
    failOn: failOnSchema.optional(),
    testGlobs: z.array(z.string()).optional(),
    detectors: z
      .object({
        skippedTests: skippedTestsSchema.optional(),
        emptyAssertions: emptyAssertionsSchema.optional(),
        suppressionRatchet: suppressionRatchetSchema.optional()
      })
      .optional()
  })
  .passthrough();

export type GuardConfigInput = z.input<typeof configInputSchema>;
export type GuardConfig = {
  version: 1;
  preset: string;
  failOn: "error" | "warning" | "never";
  testGlobs: string[];
  detectors: {
    skippedTests: {
      enabled: boolean;
      onlyAlwaysError: boolean;
      newSkipSeverity: "error" | "warning" | "info";
      legacySkipSeverity: "error" | "warning" | "info";
    };
    emptyAssertions: {
      enabled: boolean;
      emptyBodySeverity: "error" | "warning" | "info";
      noAssertSeverity: "error" | "warning" | "info";
      customAssertions: string[];
      ignoreTodo: boolean;
    };
    suppressionRatchet: {
      enabled: boolean;
      maxNewPerPR: number;
    };
  };
};

export const defaultConfig: GuardConfig = {
  version: 1,
  preset: "node",
  failOn: "error",
  testGlobs: ["**/*.{test,spec}.{js,ts,jsx,tsx}"],
  detectors: {
    skippedTests: {
      enabled: true,
      onlyAlwaysError: true,
      newSkipSeverity: "error",
      legacySkipSeverity: "warning"
    },
    emptyAssertions: {
      enabled: true,
      emptyBodySeverity: "error",
      noAssertSeverity: "warning",
      customAssertions: [],
      ignoreTodo: true
    },
    suppressionRatchet: {
      enabled: true,
      maxNewPerPR: 0
    }
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

  return {
    version: 1,
    preset: parsed.preset ?? defaultConfig.preset,
    failOn: parsed.failOn ?? defaultConfig.failOn,
    testGlobs: parsed.testGlobs ?? defaultConfig.testGlobs,
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
      suppressionRatchet: {
        ...defaultConfig.detectors.suppressionRatchet,
        ...parsed.detectors?.suppressionRatchet
      }
    }
  };
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
      suppressionRatchet: {
        ...left.detectors?.suppressionRatchet,
        ...right.detectors?.suppressionRatchet
      }
    }
  };
}
