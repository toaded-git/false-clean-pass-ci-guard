import { parse as parseYaml } from "yaml";

export interface GuardStep {
  jobId: string;
  jobName?: string;
  stepName?: string;
  uses?: string;
  with: Record<string, string>;
}

export function isWorkflowFile(file: string): boolean {
  return /^\.github\/workflows\/.+\.ya?ml$/.test(file);
}

export function findGuardStepsInWorkflow(source: string, guardStepNames: string[]): GuardStep[] {
  const document = parseWorkflow(source);
  const jobs = asRecord(document.jobs);
  if (!jobs) {
    return [];
  }

  const steps: GuardStep[] = [];
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) {
      continue;
    }

    const rawSteps = Array.isArray(job.steps) ? job.steps : [];
    for (const rawStep of rawSteps) {
      const step = asRecord(rawStep);
      if (!step) {
        continue;
      }

      const uses = typeof step.uses === "string" ? step.uses : undefined;
      const stepName = typeof step.name === "string" ? step.name : undefined;
      if (!matchesGuard(uses, stepName, guardStepNames)) {
        continue;
      }

      steps.push({
        jobId,
        jobName: typeof job.name === "string" ? job.name : undefined,
        stepName,
        uses,
        with: stringifyRecord(asRecord(step.with))
      });
    }
  }

  return steps;
}

export function workflowHasGuardStep(source: string, guardStepNames: string[]): boolean {
  return findGuardStepsInWorkflow(source, guardStepNames).length > 0;
}

function parseWorkflow(source: string): Record<string, unknown> {
  try {
    return asRecord(parseYaml(source)) ?? {};
  } catch {
    return {};
  }
}

function matchesGuard(uses: string | undefined, stepName: string | undefined, guardStepNames: string[]): boolean {
  const candidates = [uses, stepName].filter((value): value is string => Boolean(value));
  return candidates.some((candidate) =>
    guardStepNames.some((guardName) => candidate.toLowerCase().includes(guardName.toLowerCase()))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringifyRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value) {
    return result;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) {
      result[key] = "";
    } else if (typeof raw === "string") {
      result[key] = raw;
    } else {
      result[key] = String(raw);
    }
  }

  return result;
}
