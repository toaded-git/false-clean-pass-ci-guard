import { isJavaScriptLikeFile, isPythonFile } from "../core/globs";
import type { Detector, DetectorContext, Finding, Severity } from "../core/types";
import { extractEnvReferences } from "../parse/envrefs";

export const envMissingDetector: Detector = {
  id: "env-missing",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.envMissing;
    if (!options.enabled) {
      return [];
    }

    const findings: Finding[] = [];
    const declaredKeys = await readDeclaredEnvKeys(ctx, options.exampleFiles);
    const providedKeys = new Set([...ctx.ciEnvKeys, ...options.knownProvided]);
    const requiredKeys = new Set(options.required);
    const optionalKeys = new Set(options.optional);

    for (const key of requiredKeys) {
      if (isIgnoredKey(key, options.ignore) || providedKeys.has(key)) {
        continue;
      }
      findings.push({
        detector: envMissingDetector.id,
        severity: "error",
        ruleId: "false-clean-pass/env-required-missing",
        message: `Required env key ${key} is not listed in ci-env-keys.`
      });
    }

    const changedSourceFiles = ctx.diff.filter(
      (file) => file.status !== "removed" && (isJavaScriptLikeFile(file.filename) || isPythonFile(file.filename))
    );
    const seen = new Set<string>();

    for (const file of changedSourceFiles) {
      const references = extractEnvReferences(file.filename, await ctx.readFile(file.filename));
      for (const reference of references) {
        if (reference.dynamic) {
          findings.push({
            detector: envMissingDetector.id,
            severity: options.dynamicAccessSeverity,
            ruleId: "false-clean-pass/env-dynamic-access",
            file: file.filename,
            line: reference.line,
            evidence: reference.evidence,
            message: "Dynamic env access cannot be checked against CI-provided key names."
          });
          continue;
        }

        const key = reference.key;
        if (!key || isIgnoredKey(key, options.ignore) || providedKeys.has(key) || requiredKeys.has(key)) {
          continue;
        }

        const dedupeKey = `${file.filename}:${key}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        const declared = declaredKeys.has(key);
        findings.push({
          detector: envMissingDetector.id,
          severity: severityForKey(key, declared, requiredKeys, optionalKeys, options),
          ruleId: declared ? "false-clean-pass/env-example-not-in-ci" : "false-clean-pass/env-missing",
          file: file.filename,
          line: reference.line,
          evidence: reference.evidence,
          message: declared
            ? `Env key ${key} is declared in an example file but is not listed in ci-env-keys.`
            : `Env key ${key} is referenced by code but is not declared in env examples or ci-env-keys.`
        });
      }
    }

    return findings;
  }
};

async function readDeclaredEnvKeys(ctx: DetectorContext, exampleFiles: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const file of exampleFiles) {
    if (!(await ctx.fileExists(file))) {
      continue;
    }
    const source = await ctx.readFile(file);
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) {
        keys.add(match[1] ?? "");
      }
    }
  }
  keys.delete("");
  return keys;
}

function severityForKey(
  key: string,
  declared: boolean,
  requiredKeys: Set<string>,
  optionalKeys: Set<string>,
  options: {
    missingSeverity: Severity;
    exampleMissingCiSeverity: Severity;
    optionalSeverity: Severity;
  }
): Severity {
  if (requiredKeys.has(key)) {
    return "error";
  }
  if (optionalKeys.has(key)) {
    return options.optionalSeverity;
  }
  return declared ? options.exampleMissingCiSeverity : options.missingSeverity;
}

function isIgnoredKey(key: string, ignore: string[]): boolean {
  return ignore.some((pattern) => {
    if (!pattern.includes("*")) {
      return pattern === key;
    }
    const source = `^${pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*")}$`;
    return new RegExp(source).test(key);
  });
}
