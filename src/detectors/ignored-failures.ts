import { matchesAnyGlob } from "../core/globs";
import { isContinueOnErrorAllowed } from "../core/allowlist";
import { findAllowedJobForLine } from "../core/job-scope";
import type { Detector, DetectorContext, Finding, Severity } from "../core/types";
import { workflowHasGuardStep } from "../parse/yaml-scan";
import { findStepForLine, isWorkflowFile, parseWorkflow, type ParsedWorkflow } from "../parse/workflow-parser";

const failOnRank: Record<string, number> = {
  error: 0,
  warning: 1,
  never: 2
};

export const ignoredFailuresDetector: Detector = {
  id: "ignored-failures",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.ignoredFailures;
    if (!options.enabled) {
      return [];
    }

    const findings: Finding[] = [];
    if (options.selfAttestation && ctx.checkRunAttestationVerifier) {
      const attestation = await ctx.checkRunAttestationVerifier();
      if (!attestation.ok) {
        findings.push({
          detector: ignoredFailuresDetector.id,
          severity: options.guardWeakeningSeverity,
          ruleId:
            attestation.reason === "sha-mismatch"
              ? "false-clean-pass/checkrun-sha-mismatch"
              : "false-clean-pass/checkrun-marker-missing",
          message: attestation.message ?? "false-clean-pass Check Run self-attestation could not be verified."
        });
      }
    }

    const guardExistsInHead = await hasGuardStepInHeadWorkflows(ctx);
    for (const file of ctx.diff) {
      if (file.status === "removed") {
        continue;
      }

      const workflowContext = await parseHeadWorkflow(ctx, file.filename);
      findings.push(...scanFailureIgnorePatterns(file, options, workflowContext));
      findings.push(...scanGuardWeakeningDiff(file, options.guardWeakeningSeverity, options.guardStepNames, guardExistsInHead));
      findings.push(...scanConfigWeakeningDiff(file, options.guardWeakeningSeverity));
    }

    return dedupeFindings(findings);
  }
};

function scanFailureIgnorePatterns(
  file: DetectorContext["diff"][number],
  options: {
    newSeverity: Severity;
    allowJobs: string[];
    allowContinueOnErrorSteps: string[];
    allowCleanupCommands: boolean;
  },
  workflowContext: WorkflowScanContext | undefined
): Finding[] {
  if (!isFailureIgnoreTarget(file.filename)) {
    return [];
  }

  const findings: Finding[] = [];
  for (const [line, content] of file.addedLineContent.entries()) {
    const trimmed = content.trim();
    const rule = failureIgnoreRule(trimmed, options.allowCleanupCommands);
    if (!rule) {
      continue;
    }

    if (
      rule.ruleId === "false-clean-pass/continue-on-error" &&
      isContinueOnErrorAllowed(
        workflowContext ? findStepForLine(workflowContext.workflow, line) : undefined,
        workflowContext?.source ?? "",
        options.allowContinueOnErrorSteps
      )
    ) {
      continue;
    }

    const finding: Finding = {
      detector: ignoredFailuresDetector.id,
      severity: options.newSeverity,
      ruleId: rule.ruleId,
      file: file.filename,
      line,
      evidence: trimmed,
      message: rule.message
    };

    if (findAllowedJobForLine(workflowContext?.workflow, finding.line, options.allowJobs)) {
      continue;
    }

    findings.push(finding);
  }
  return findings;
}

function failureIgnoreRule(content: string, allowCleanupCommands: boolean): { ruleId: string; message: string } | undefined {
  if (/continue-on-error\s*:\s*true\b/i.test(content)) {
    return {
      ruleId: "false-clean-pass/continue-on-error",
      message: "New continue-on-error: true can hide a failing CI step."
    };
  }
  if (/\|\|\s*true\b/.test(content) || /;\s*true\s*$/.test(content)) {
    if (allowCleanupCommands && /\b(cleanup|teardown)\b/i.test(content)) {
      return undefined;
    }
    return {
      ruleId: "false-clean-pass/ignore-failure-shell",
      message: "New shell success fallback can hide a failing command."
    };
  }
  if (/--pass(?:WithNoTests|-with-no-tests)\b/.test(content)) {
    return {
      ruleId: "false-clean-pass/pass-with-no-tests",
      message: "New pass-with-no-tests flag can make an empty test run pass."
    };
  }
  if (/^\s*exit\s+0\s*$/.test(content)) {
    return {
      ruleId: "false-clean-pass/exit-zero",
      message: "New unconditional exit 0 can hide a failing command."
    };
  }
  return undefined;
}

function scanGuardWeakeningDiff(
  file: DetectorContext["diff"][number],
  severity: Severity,
  guardStepNames: string[],
  guardExistsInHead: boolean
): Finding[] {
  const findings: Finding[] = [];
  if (!isWorkflowFile(file.filename)) {
    return findings;
  }

  const removedLines = [...file.removedLineContent.entries()];
  const addedLines = [...file.addedLineContent.entries()];

  if (
    !guardExistsInHead &&
    removedLines.some(([, content]) => lineMentionsGuardStep(content, guardStepNames))
  ) {
    findings.push({
      detector: ignoredFailuresDetector.id,
      severity,
      ruleId: "false-clean-pass/guard-step-removed",
      file: file.filename,
      message: "false-clean-pass guard step was removed and no replacement guard step exists in workflow files."
    });
  }

  const removedFailOn = removedLines.map(([line, content]) => ({ line, value: parseFailOnLine(content) })).filter(hasValue);
  const addedFailOn = addedLines.map(([line, content]) => ({ line, value: parseFailOnLine(content), content })).filter(hasValue);
  for (const added of addedFailOn) {
    if (removedFailOn.some((removed) => failOnRank[added.value] > failOnRank[removed.value])) {
      findings.push({
        detector: ignoredFailuresDetector.id,
        severity,
        ruleId: "false-clean-pass/fail-on-weakened",
        file: file.filename,
        line: added.line,
        evidence: added.content.trim(),
        message: "false-clean-pass fail-on threshold was weakened."
      });
    }
  }

  if (
    removedLines.some(([, content]) => /test-results-glob\s*:\s*\S+/i.test(content)) &&
    !addedLines.some(([, content]) => /test-results-glob\s*:\s*\S+/i.test(content))
  ) {
    findings.push({
      detector: ignoredFailuresDetector.id,
      severity,
      ruleId: "false-clean-pass/test-results-glob-removed",
      file: file.filename,
      message: "false-clean-pass test-results-glob was removed or blanked."
    });
  }

  findings.push(...scanTriggerWeakening(file, severity));
  findings.push(...scanIfWeakening(file, severity));
  findings.push(...scanJobNameWeakening(file, severity, guardStepNames));

  return findings;
}

function scanTriggerWeakening(file: DetectorContext["diff"][number], severity: Severity): Finding[] {
  const removedPullRequest = [...file.removedLineContent.values()].some((content) => /\bpull_request\b/.test(content));
  const addedPullRequest = [...file.addedLineContent.values()].some((content) => /\bpull_request\b/.test(content));
  const addedWeakOn = [...file.addedLineContent.entries()].find(([, content]) => /^\s*on\s*:\s*(push|workflow_dispatch)\s*$/i.test(content.trim()));
  if (!removedPullRequest || addedPullRequest) {
    return [];
  }

  const line = addedWeakOn?.[0];
  return [
    {
      detector: ignoredFailuresDetector.id,
      severity,
      ruleId: "false-clean-pass/workflow-trigger-weakened",
      file: file.filename,
      line,
      evidence: addedWeakOn?.[1].trim(),
      message: "Workflow pull_request trigger was removed or weakened for the guard."
    }
  ];
}

function scanIfWeakening(file: DetectorContext["diff"][number], severity: Severity): Finding[] {
  const findings: Finding[] = [];
  for (const [line, content] of file.addedLineContent.entries()) {
    const trimmed = content.trim();
    if (!/^if\s*:/.test(trimmed)) {
      continue;
    }
    if (/\bfalse\b/.test(trimmed) || /\$\{\{\s*!/.test(trimmed) || /github\.event_name\s*==\s*['"]never['"]/.test(trimmed)) {
      findings.push({
        detector: ignoredFailuresDetector.id,
        severity,
        ruleId: "false-clean-pass/guard-if-weakened",
        file: file.filename,
        line,
        evidence: trimmed,
        message: "Workflow if condition can skip the required false-clean-pass guard."
      });
    }
  }
  return findings;
}

function scanJobNameWeakening(file: DetectorContext["diff"][number], severity: Severity, guardStepNames: string[]): Finding[] {
  const removedGuardName = [...file.removedLineContent.values()].some(
    (content) => /^\s*name\s*:/.test(content) && lineMentionsGuardStep(content, guardStepNames)
  );
  const addedNonGuardName = [...file.addedLineContent.entries()].find(
    ([, content]) => /^\s*name\s*:/.test(content) && !lineMentionsGuardStep(content, guardStepNames)
  );
  if (!removedGuardName || !addedNonGuardName) {
    return [];
  }
  return [
    {
      detector: ignoredFailuresDetector.id,
      severity,
      ruleId: "false-clean-pass/guard-job-name-weakened",
      file: file.filename,
      line: addedNonGuardName[0],
      evidence: addedNonGuardName[1].trim(),
      message: "false-clean-pass workflow or job name was changed, which can bypass a required check."
    }
  ];
}

function scanConfigWeakeningDiff(file: DetectorContext["diff"][number], severity: Severity): Finding[] {
  if (file.filename !== ".github/false-clean-pass.yml" && file.filename !== ".github/false-clean-pass.yaml") {
    return [];
  }

  const findings: Finding[] = [];
  for (const [line, content] of file.addedLineContent.entries()) {
    const trimmed = content.trim();
    if (/^enabled\s*:\s*false\b/i.test(trimmed)) {
      findings.push({
        detector: ignoredFailuresDetector.id,
        severity,
        ruleId: "false-clean-pass/detector-disabled",
        file: file.filename,
        line,
        evidence: trimmed,
        message: "Detector enabled flag was disabled in false-clean-pass config."
      });
    }
    if (/^required\s*:\s*\[\s*\]\s*$/i.test(trimmed)) {
      findings.push({
        detector: ignoredFailuresDetector.id,
        severity,
        ruleId: "false-clean-pass/required-list-weakened",
        file: file.filename,
        line,
        evidence: trimmed,
        message: "Required guard list was emptied in false-clean-pass config."
      });
    }
  }

  if ([...file.removedLineContent.values()].some((content) => /^\s*required\s*:\s*\[?\s*\S/.test(content))) {
    findings.push({
      detector: ignoredFailuresDetector.id,
      severity,
      ruleId: "false-clean-pass/required-list-weakened",
      file: file.filename,
      message: "Required guard list entries were removed in false-clean-pass config."
    });
  }

  return findings;
}

async function hasGuardStepInHeadWorkflows(ctx: DetectorContext): Promise<boolean> {
  const files = await ctx.listFiles();
  const workflowFiles = files.filter(isWorkflowFile);
  for (const file of workflowFiles) {
    try {
      if (workflowHasGuardStep(await ctx.readFile(file), ctx.config.detectors.ignoredFailures.guardStepNames)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

interface WorkflowScanContext {
  source: string;
  workflow: ParsedWorkflow;
}

async function parseHeadWorkflow(ctx: DetectorContext, file: string): Promise<WorkflowScanContext | undefined> {
  if (!isWorkflowFile(file)) {
    return undefined;
  }

  try {
    const source = await ctx.readFile(file);
    return {
      source,
      workflow: parseWorkflow(source, { filePath: file })
    };
  } catch {
    return undefined;
  }
}

function isFailureIgnoreTarget(file: string): boolean {
  return (
    isWorkflowFile(file) ||
    file === "package.json" ||
    file === "Makefile" ||
    matchesAnyGlob(file, ["**/*.sh", "**/*.bash", "**/*.zsh"])
  );
}

function lineMentionsGuardStep(content: string, guardStepNames: string[]): boolean {
  return guardStepNames.some((guardName) => content.toLowerCase().includes(guardName.toLowerCase()));
}

function parseFailOnLine(content: string): "error" | "warning" | "never" | undefined {
  const match = content.match(/fail-on\s*:\s*["']?(error|warning|never)["']?/i);
  return match?.[1]?.toLowerCase() as "error" | "warning" | "never" | undefined;
}

function hasValue<T extends { value?: unknown }>(entry: T): entry is T & { value: "error" | "warning" | "never" } {
  return Boolean(entry.value);
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.ruleId}:${finding.file ?? ""}:${finding.line ?? 0}:${finding.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
