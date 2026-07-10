import type { Detector, DetectorContext, Finding } from "../core/types";

const suppressionPatterns = [
  /\beslint-disable(?:-(?:next-line|line))?\b/,
  /@ts-ignore\b/,
  /@ts-expect-error\b/,
  /#\s*type:\s*ignore\b/,
  /#\s*noqa\b/,
  /#\s*pylint:\s*disable\b/
];

interface SuppressionHit {
  file: string;
  line: number;
  evidence: string;
}

export const suppressionRatchetDetector: Detector = {
  id: "suppression-ratchet",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.detectors.suppressionRatchet;
    if (!options.enabled) {
      return [];
    }

    const newSuppressions = collectNewSuppressions(ctx);
    if (newSuppressions.length <= options.maxNewPerPR) {
      return [];
    }

    // Milestone 1 intentionally stops at diff-added suppressions. Repository-wide
    // suppression totals, baselines, and ratchets are milestone 2 scope.
    return newSuppressions.map((hit): Finding => ({
      detector: suppressionRatchetDetector.id,
      severity: "error",
      ruleId: "false-clean-pass/new-suppression",
      file: hit.file,
      line: hit.line,
      evidence: hit.evidence.trim(),
      message: `New suppression comment exceeds maxNewPerPR=${options.maxNewPerPR} (${newSuppressions.length} added).`
    }));
  }
};

function collectNewSuppressions(ctx: DetectorContext): SuppressionHit[] {
  const hits: SuppressionHit[] = [];

  for (const file of ctx.diff) {
    if (file.status === "removed") {
      continue;
    }

    for (const [line, content] of file.addedLineContent.entries()) {
      if (suppressionPatterns.some((pattern) => pattern.test(content))) {
        hits.push({
          file: file.filename,
          line,
          evidence: content
        });
      }
    }
  }

  return hits;
}
