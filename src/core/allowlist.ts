import { matchesAnyGlob } from "./globs";
import type { WorkflowStep } from "../parse/workflow-parser";

const continueOnErrorAllowComment = /#\s*fcp-allow:\s*continue-on-error\s+(.+)$/i;

export function isContinueOnErrorAllowed(
  step: WorkflowStep | undefined,
  source: string,
  allowContinueOnErrorSteps: string[]
): boolean {
  if (!step) {
    return false;
  }

  if (matchesStepAllowlist(step, allowContinueOnErrorSteps)) {
    return true;
  }

  return hasInlineAllowComment(source, step);
}

function matchesStepAllowlist(step: WorkflowStep, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const candidates = [step.stepName, step.uses].filter((value): value is string => Boolean(value));
  return candidates.some((candidate) => matchesAnyGlob(candidate, patterns));
}

function hasInlineAllowComment(source: string, step: WorkflowStep): boolean {
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, step.line - 2);
  for (let line = start; line <= step.endLine; line += 1) {
    const content = lines[line - 1] ?? "";
    const match = content.match(continueOnErrorAllowComment);
    if (match?.[1]?.trim()) {
      return true;
    }
  }
  return false;
}
