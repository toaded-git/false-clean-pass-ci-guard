import { matchesAnyGlob } from "./globs";
import { findJobForLine, type ParsedWorkflow, type WorkflowJob } from "../parse/workflow-parser";

export function findAllowedJobForLine(
  workflow: ParsedWorkflow | undefined,
  line: number | undefined,
  allowJobs: string[]
): WorkflowJob | undefined {
  if (!workflow || line === undefined || allowJobs.length === 0) {
    return undefined;
  }

  const job = findJobForLine(workflow, line);
  if (!job) {
    return undefined;
  }

  return jobMatchesAllowlist(job, allowJobs) ? job : undefined;
}

function jobMatchesAllowlist(job: WorkflowJob, allowJobs: string[]): boolean {
  const candidates = [job.id, job.name].filter((value): value is string => Boolean(value));
  return candidates.some((candidate) => matchesAnyGlob(candidate, allowJobs));
}
