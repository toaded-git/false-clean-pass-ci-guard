import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Finding, RunResult, Severity } from "../core/types";

export interface SarifLog {
  version: "2.1.0";
  $schema: "https://json.schemastore.org/sarif-2.1.0.json";
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: {
    text: string;
  };
  defaultConfiguration: {
    level: "error" | "warning" | "note";
  };
  properties: {
    detector: string;
  };
}

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: {
    text: string;
  };
  locations?: SarifLocation[];
  properties: {
    detector: string;
    severity: Severity;
    evidence?: string;
  };
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: {
      uri: string;
    };
    region?: {
      startLine: number;
    };
  };
}

export interface WriteSarifOptions {
  rootDir: string;
  sarifPath: string;
}

export function createSarifLog(result: RunResult): SarifLog {
  const rules = [...ruleMap(result.findings).values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "false-clean-pass",
            informationUri: "https://github.com/false-clean-pass-ci-guard/false-clean-pass-ci-guard",
            rules
          }
        },
        results: result.findings.map(findingToSarifResult)
      }
    ]
  };
}

export async function writeSarifLogFile(result: RunResult, options: WriteSarifOptions): Promise<string> {
  const absolutePath = resolve(options.rootDir, options.sarifPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(createSarifLog(result), null, 2)}\n`, "utf8");
  return options.sarifPath;
}

function ruleMap(findings: Finding[]): Map<string, SarifRule> {
  const rules = new Map<string, SarifRule>();
  for (const finding of findings) {
    const existing = rules.get(finding.ruleId);
    if (existing && ruleLevelRank(existing.defaultConfiguration.level) >= ruleLevelRank(levelForSeverity(finding.severity))) {
      continue;
    }

    rules.set(finding.ruleId, {
      id: finding.ruleId,
      name: finding.ruleId,
      shortDescription: {
        text: finding.ruleId
      },
      defaultConfiguration: {
        level: levelForSeverity(finding.severity)
      },
      properties: {
        detector: finding.detector
      }
    });
  }
  return rules;
}

function findingToSarifResult(finding: Finding): SarifResult {
  const result: SarifResult = {
    ruleId: finding.ruleId,
    level: levelForSeverity(finding.severity),
    message: {
      text: finding.message
    },
    properties: {
      detector: finding.detector,
      severity: finding.severity,
      evidence: finding.evidence
    }
  };

  const location = findingToLocation(finding);
  if (location) {
    result.locations = [location];
  }
  return result;
}

function findingToLocation(finding: Finding): SarifLocation | undefined {
  if (!finding.file) {
    return undefined;
  }

  const physicalLocation: SarifLocation["physicalLocation"] = {
    artifactLocation: {
      uri: finding.file.replace(/\\/g, "/")
    }
  };
  if (finding.line && finding.line > 0) {
    physicalLocation.region = {
      startLine: finding.line
    };
  }
  return { physicalLocation };
}

function levelForSeverity(severity: Severity): "error" | "warning" | "note" {
  if (severity === "error") {
    return "error";
  }
  return severity === "warning" ? "warning" : "note";
}

function ruleLevelRank(level: "error" | "warning" | "note"): number {
  if (level === "error") {
    return 3;
  }
  return level === "warning" ? 2 : 1;
}
