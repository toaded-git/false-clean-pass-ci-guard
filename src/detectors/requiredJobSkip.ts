import type { Detector, DetectorContext, Finding } from "../core/types";
import {
  isWorkflowFile,
  parseWorkflowFiles,
  type ParsedWorkflow,
  type WorkflowCheckMapping,
  type WorkflowTriggers,
  type WorkflowUnresolvedCheckMapping
} from "../parse/workflow-parser";

type EvidenceAttemptSeverity = "high" | "review";
type EvidenceWeakeningSeverity = "medium";

interface EvidenceAttemptMetadata {
  recordSection: "attempts";
  kind:
    | "required_job_missing"
    | "required_job_if_skip_risk"
    | "required_job_if_added_review"
    | "required_workflow_trigger_narrowed"
    | "required_config_narrowed";
  severity: EvidenceAttemptSeverity;
  target: string;
  detail: string;
  file?: string;
  line?: number;
  baseValue?: string | null;
  headValue?: string | null;
}

interface EvidenceWeakeningMetadata {
  recordSection: "weakenings";
  kind: "mapping_unresolved";
  severity: EvidenceWeakeningSeverity;
  target: string;
  detail: string;
  file?: string;
  line?: number;
}

interface WorkflowState {
  sources: Record<string, string>;
  workflows: ParsedWorkflow[];
  mappings: Map<string, WorkflowCheckMapping[]>;
  unresolved: WorkflowUnresolvedCheckMapping[];
}

const detectorId = "required-job-skip";

export const requiredJobSkipDetector: Detector = {
  id: detectorId,
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.requiredJobSkip;
    if (!options.enabled) {
      return [];
    }

    const workflowChanged = ctx.diff.some((file) => isWorkflowFile(file.filename) || isWorkflowFile(file.previousFilename ?? ""));
    const requiredJobs = normalizeList(options.requiredJobs);

    if (requiredJobs.length === 0 && !workflowChanged) {
      return [];
    }

    const [headState, baseState] = await Promise.all([loadHeadWorkflowState(ctx), loadBaseWorkflowState(ctx)]);
    const findings = dedupeFindings([
      ...detectRequiredJobsInputNarrowed(baseState, headState),
      ...detectRequiredWorkflowTriggerNarrowed(requiredJobs, baseState, headState)
    ]);

    if (requiredJobs.length === 0) {
      findings.push({
        detector: detectorId,
        severity: "info",
        ruleId: "false-clean-pass/required-jobs-unconfigured",
        message:
          "requiredJobs is not configured, and branch protection required checks were not available to this run; required job skip detection is informational only."
      });
      return dedupeFindings(findings);
    }

    findings.push(...(await detectCheckRunSupplement(ctx, requiredJobs)));

    for (const requiredJob of requiredJobs) {
      findings.push(...detectRequiredJobMapping(requiredJob, baseState, headState));
      findings.push(...detectRequiredJobIfChange(requiredJob, baseState, headState));
    }

    return dedupeFindings(findings);
  }
};

async function detectCheckRunSupplement(ctx: DetectorContext, requiredJobs: string[]): Promise<Finding[]> {
  if (!ctx.github || requiredJobs.length === 0) {
    return [];
  }

  try {
    const github = await import("@actions/github");
    const octokit = github.getOctokit(ctx.github.token);
    const response = await octokit.rest.checks.listForRef({
      owner: ctx.github.owner,
      repo: ctx.github.repo,
      ref: ctx.github.headSha,
      per_page: 100
    });
    const checkRuns = response.data.check_runs ?? [];
    const findings: Finding[] = [];

    for (const requiredJob of requiredJobs) {
      const checkRun = checkRuns.find((run) => run.name === requiredJob);
      if (!checkRun) {
        findings.push({
          detector: detectorId,
          severity: "warning",
          ruleId: "false-clean-pass/required_check_run_missing",
          message: `Required check '${requiredJob}' was not present in head check-runs; this is a supplementary signal only.`
        });
      } else if (checkRun.conclusion === "skipped") {
        findings.push({
          detector: detectorId,
          severity: "warning",
          ruleId: "false-clean-pass/required_check_run_skipped",
          message: `Required check '${requiredJob}' concluded skipped; this is a supplementary signal only.`
        });
      }
    }

    return findings;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        detector: detectorId,
        severity: "info",
        ruleId: "false-clean-pass/check-runs-unavailable",
        message: `Check-runs supplementary lookup was unavailable: ${message}`
      }
    ];
  }
}

async function loadHeadWorkflowState(ctx: DetectorContext): Promise<WorkflowState> {
  const files = (await ctx.listFiles()).filter(isWorkflowFile);
  const sources: Record<string, string> = {};
  for (const file of files) {
    try {
      sources[file] = await ctx.readFile(file);
    } catch {
      // Removed files are represented in the diff and do not exist in head.
    }
  }
  return buildWorkflowState(sources);
}

async function loadBaseWorkflowState(ctx: DetectorContext): Promise<WorkflowState> {
  if (!ctx.readBaseFile) {
    return buildWorkflowState({});
  }

  const headFiles = (await ctx.listFiles()).filter(isWorkflowFile);
  const diffFiles = ctx.diff.flatMap((file) => [file.filename, file.previousFilename].filter((name): name is string => Boolean(name)));
  const candidateFiles = [...new Set([...headFiles, ...diffFiles].filter(isWorkflowFile))];
  const sources: Record<string, string> = {};

  for (const file of candidateFiles) {
    try {
      sources[file] = await ctx.readBaseFile(file);
    } catch {
      // New workflow files have no base version.
    }
  }

  return buildWorkflowState(sources);
}

function buildWorkflowState(sources: Record<string, string>): WorkflowState {
  const workflows = parseWorkflowFiles(sources);
  const mappings = new Map<string, WorkflowCheckMapping[]>();
  const unresolved: WorkflowUnresolvedCheckMapping[] = [];

  for (const workflow of workflows) {
    for (const mapping of workflow.checkMappings) {
      mappings.set(mapping.checkName, [...(mappings.get(mapping.checkName) ?? []), mapping]);
    }
    unresolved.push(...workflow.unresolvedCheckMappings);
  }

  return {
    sources,
    workflows,
    mappings,
    unresolved
  };
}

function detectRequiredJobMapping(requiredJob: string, baseState: WorkflowState, headState: WorkflowState): Finding[] {
  const headMappings = headState.mappings.get(requiredJob) ?? [];
  if (headMappings.length > 0) {
    return [];
  }

  const unresolved = findPlausibleUnresolved(requiredJob, headState.unresolved);
  if (unresolved) {
    const detail = mappingUnresolvedDetail(requiredJob, unresolved);
    return [
      {
        detector: detectorId,
        severity: "warning",
        ruleId: "false-clean-pass/mapping_unresolved",
        file: unresolved.file,
        line: unresolved.line,
        message: detail,
        metadata: {
          evidenceRecord: {
            recordSection: "weakenings",
            kind: "mapping_unresolved",
            severity: "medium",
            target: requiredJob,
            detail,
            file: unresolved.file,
            line: unresolved.line
          } satisfies EvidenceWeakeningMetadata
        }
      }
    ];
  }

  const baseMappings = baseState.mappings.get(requiredJob) ?? [];
  const mapping = baseMappings[0];
  const detail =
    baseMappings.length > 0
      ? `required job '${requiredJob}' existed in base workflow mapping but is missing from head workflow mapping.`
      : `required job '${requiredJob}' is not produced by any statically mapped head workflow job.`;

  return [
    {
      detector: detectorId,
      severity: "error",
      ruleId: "false-clean-pass/required_job_missing",
      file: mapping?.file,
      line: mapping?.line,
      message: detail,
      metadata: {
        evidenceRecord: {
          recordSection: "attempts",
          kind: "required_job_missing",
          severity: "high",
          target: requiredJob,
          detail,
          file: mapping?.file,
          line: mapping?.line,
          baseValue: requiredJob,
          headValue: null
        } satisfies EvidenceAttemptMetadata
      }
    }
  ];
}

function detectRequiredJobIfChange(requiredJob: string, baseState: WorkflowState, headState: WorkflowState): Finding[] {
  const baseMappings = baseState.mappings.get(requiredJob) ?? [];
  const headMappings = headState.mappings.get(requiredJob) ?? [];
  const findings: Finding[] = [];

  for (const headMapping of headMappings) {
    const headJob = findWorkflowJob(headState, headMapping);
    if (!headJob?.if) {
      continue;
    }

    const baseMapping = baseMappings.find((mapping) => mapping.file === headMapping.file && mapping.jobId === headMapping.jobId) ?? baseMappings[0];
    const baseJob = baseMapping ? findWorkflowJob(baseState, baseMapping) : undefined;
    if (normalizeIfExpression(baseJob?.if) === normalizeIfExpression(headJob.if)) {
      continue;
    }

    const classification = classifyJobIf(headJob.if);
    if (classification === "legitimate") {
      continue;
    }

    const kind = classification === "skip-risk" ? "required_job_if_skip_risk" : "required_job_if_added_review";
    const severity = classification === "skip-risk" ? "error" : "warning";
    const recordSeverity = classification === "skip-risk" ? "high" : "review";
    const detail =
      classification === "skip-risk"
        ? `job-level if adds a skip-risk condition to required job '${requiredJob}'.`
        : `ambiguous job-level if added to required job '${requiredJob}' requires manual review.`;

    findings.push({
      detector: detectorId,
      severity,
      ruleId: `false-clean-pass/${kind}`,
      file: headMapping.file,
      line: headJob.ifLine ?? headMapping.line,
      evidence: headJob.if,
      message: detail,
      metadata: {
        evidenceRecord: {
          recordSection: "attempts",
          kind,
          severity: recordSeverity,
          target: requiredJob,
          detail,
          file: headMapping.file,
          line: headJob.ifLine ?? headMapping.line,
          baseValue: baseJob?.if ?? null,
          headValue: headJob.if
        } satisfies EvidenceAttemptMetadata
      }
    });
  }

  return findings;
}

function detectRequiredWorkflowTriggerNarrowed(
  requiredJobs: string[],
  baseState: WorkflowState,
  headState: WorkflowState
): Finding[] {
  if (requiredJobs.length === 0) {
    return [];
  }

  const findings: Finding[] = [];
  const seenFiles = new Set<string>();
  for (const requiredJob of requiredJobs) {
    const mappings = [...(baseState.mappings.get(requiredJob) ?? []), ...(headState.mappings.get(requiredJob) ?? [])];
    for (const mapping of mappings) {
      if (seenFiles.has(mapping.file)) {
        continue;
      }
      seenFiles.add(mapping.file);

      const baseWorkflow = baseState.workflows.find((workflow) => workflow.file === mapping.file);
      const headWorkflow = headState.workflows.find((workflow) => workflow.file === mapping.file);
      if (!baseWorkflow || !headWorkflow) {
        continue;
      }

      const narrowed = pullRequestTriggerNarrowed(baseWorkflow.on, headWorkflow.on);
      if (!narrowed) {
        continue;
      }

      const detail = `workflow pull_request trigger for required job '${requiredJob}' was narrowed: ${narrowed}.`;
      findings.push({
        detector: detectorId,
        severity: "error",
        ruleId: "false-clean-pass/required_workflow_trigger_narrowed",
        file: mapping.file,
        line: 1,
        message: detail,
        metadata: {
          evidenceRecord: {
            recordSection: "attempts",
            kind: "required_workflow_trigger_narrowed",
            severity: "high",
            target: requiredJob,
            detail,
            file: mapping.file,
            line: 1,
            baseValue: JSON.stringify(baseWorkflow.on.events.pull_request ?? null),
            headValue: JSON.stringify(headWorkflow.on.events.pull_request ?? null)
          } satisfies EvidenceAttemptMetadata
        }
      });
    }
  }
  return findings;
}

function detectRequiredJobsInputNarrowed(baseState: WorkflowState, headState: WorkflowState): Finding[] {
  const baseInputs = extractGuardRequiredJobsInputs(baseState.workflows);
  if (baseInputs.length === 0) {
    return [];
  }

  const headInputs = extractGuardRequiredJobsInputs(headState.workflows);
  const baseJobs = new Set(baseInputs.flatMap((input) => input.requiredJobs));
  const headJobs = new Set(headInputs.flatMap((input) => input.requiredJobs));
  const removed = [...baseJobs].filter((job) => !headJobs.has(job));
  if (removed.length === 0) {
    return [];
  }

  const input = baseInputs[0];
  const detail = `with.requiredJobs was narrowed; removed required job(s): ${removed.join(", ")}.`;
  return [
    {
      detector: detectorId,
      severity: "error",
      ruleId: "false-clean-pass/required_config_narrowed",
      file: input?.file,
      line: input?.line,
      message: detail,
      metadata: {
        evidenceRecord: {
          recordSection: "attempts",
          kind: "required_config_narrowed",
          severity: "high",
          target: removed.join(", "),
          detail,
          file: input?.file,
          line: input?.line,
          baseValue: [...baseJobs].join(","),
          headValue: [...headJobs].join(",") || null
        } satisfies EvidenceAttemptMetadata
      }
    }
  ];
}

function extractGuardRequiredJobsInputs(workflows: ParsedWorkflow[]): Array<{ file: string; line: number; requiredJobs: string[] }> {
  const inputs: Array<{ file: string; line: number; requiredJobs: string[] }> = [];
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (!step.uses || !isFalseCleanPassAction(step.uses)) {
        continue;
      }

      const raw = step.with?.requiredJobs ?? step.with?.["required-jobs"];
      const requiredJobs = normalizeList(raw);
      if (requiredJobs.length > 0 || raw !== undefined) {
        inputs.push({
          file: workflow.file,
          line: step.line,
          requiredJobs
        });
      }
    }
  }
  return inputs;
}

function pullRequestTriggerNarrowed(base: WorkflowTriggers, head: WorkflowTriggers): string | undefined {
  const basePullRequest = base.events.pull_request;
  if (!basePullRequest) {
    return undefined;
  }

  const headPullRequest = head.events.pull_request;
  if (!headPullRequest) {
    return "pull_request event was removed";
  }

  if (hasAddedEntries(basePullRequest.pathsIgnore, headPullRequest.pathsIgnore)) {
    return "paths-ignore was expanded; manual confirmation is required for boundary globs";
  }
  if (hasAddedEntries(basePullRequest.branchesIgnore, headPullRequest.branchesIgnore)) {
    return "branches-ignore was expanded";
  }
  if (positiveFilterNarrowed(basePullRequest.paths, headPullRequest.paths)) {
    return "paths filter was narrowed or changed; manual confirmation is required for boundary globs";
  }
  if (positiveFilterNarrowed(basePullRequest.branches, headPullRequest.branches)) {
    return "branches filter was narrowed";
  }

  return undefined;
}

function positiveFilterNarrowed(baseValues: string[], headValues: string[]): boolean {
  if (baseValues.length === 0) {
    return headValues.length > 0;
  }
  if (headValues.length === 0) {
    return false;
  }
  return baseValues.some((value) => !headValues.includes(value));
}

function hasAddedEntries(baseValues: string[], headValues: string[]): boolean {
  return headValues.some((value) => !baseValues.includes(value));
}

function findWorkflowJob(state: WorkflowState, mapping: WorkflowCheckMapping) {
  return state.workflows.find((workflow) => workflow.file === mapping.file)?.jobs.find((job) => job.id === mapping.jobId);
}

function findPlausibleUnresolved(
  requiredJob: string,
  unresolved: WorkflowUnresolvedCheckMapping[]
): WorkflowUnresolvedCheckMapping | undefined {
  return (
    unresolved.find((mapping) => {
      const displayName = mapping.jobName ?? mapping.jobId;
      return requiredJob === displayName || requiredJob.startsWith(`${displayName} / `);
    }) ?? unresolved[0]
  );
}

function mappingUnresolvedDetail(requiredJob: string, unresolved: WorkflowUnresolvedCheckMapping): string {
  if (unresolved.reason === "external-reusable") {
    return `required '${requiredJob}' maps through an external reusable workflow; static mapping is unresolved.`;
  }
  if (unresolved.reason === "dynamic-name") {
    return `required '${requiredJob}' may map to a job with a dynamic name expression; static mapping is unresolved.`;
  }
  return `required '${requiredJob}' maps through a local reusable workflow that could not be parsed; static mapping is unresolved.`;
}

type IfClassification = "skip-risk" | "legitimate" | "review";

function classifyJobIf(value: string): IfClassification {
  const expression = normalizeIfExpression(value);
  if (isLegitimateIfExpression(expression)) {
    return "legitimate";
  }
  if (isSkipRiskIfExpression(expression)) {
    return "skip-risk";
  }
  return "review";
}

function isSkipRiskIfExpression(expression: string): boolean {
  if (/^false$/i.test(expression)) {
    return true;
  }
  if (/\bgithub\.(actor|ref|event_name)\s*!=/.test(expression)) {
    return true;
  }
  if (/^(?:!\s*cancelled\(\)|always\(\))\s*&&\s*.+/i.test(expression)) {
    return true;
  }
  return false;
}

function isLegitimateIfExpression(expression: string): boolean {
  if (/^(?:always\(\)|!\s*cancelled\(\)|success\(\))$/i.test(expression)) {
    return true;
  }
  if (/^github\.ref\s*==\s*['"]refs\/heads\/main['"]$/i.test(expression)) {
    return true;
  }
  if (/^github\.event_name\s*==\s*['"]push['"]$/i.test(expression)) {
    return true;
  }

  const parts = expression.split(/\s*&&\s*/).map((part) => part.trim());
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        /^success\(\)$/i.test(part) ||
        /^needs\.[A-Za-z0-9_-]+\.result\s*==\s*['"]success['"]$/i.test(part) ||
        /^needs\.\*\.result\s*==\s*['"]success['"]$/i.test(part)
    )
  );
}

function normalizeIfExpression(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  const expression = trimmed.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/)?.[1] ?? trimmed;
  return expression.replace(/\s+/g, " ").trim();
}

function normalizeList(value: string[] | string | undefined): string[] {
  const items = Array.isArray(value) ? value : (value ?? "").split(",");
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function isFalseCleanPassAction(uses: string): boolean {
  return /(^|\/)false-clean-pass(?:-ci-guard)?(?:@|$)/i.test(uses);
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [finding.ruleId, finding.file, finding.line, finding.message].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
