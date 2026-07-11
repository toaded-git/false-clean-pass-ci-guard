import { matchesAnyGlob } from "../core/globs";
import type { CodeOwnerReviewProvider, Detector, DetectorContext, Finding, PullRequestReview } from "../core/types";
import { createGitHubReviewProvider } from "../gh/reviews";
import { findCodeOwnersForFile } from "../parse/codeowners";

const codeownersPaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export const baselineChangeDetector: Detector = {
  id: "baseline-change",
  async run(ctx: DetectorContext): Promise<Finding[]> {
    const options = ctx.config.baselineGuard;
    if (!options.enabled) {
      return [];
    }

    const changedBaselineFiles = ctx.diff.filter((file) => matchesAnyGlob(file.filename, options.paths));
    if (changedBaselineFiles.length === 0) {
      return [];
    }

    const nonBaselineNonDocFiles = ctx.diff.filter(
      (file) => !matchesAnyGlob(file.filename, options.paths) && !isDocumentationFile(file.filename)
    );
    if (nonBaselineNonDocFiles.length > 0) {
      const changedFiles = nonBaselineNonDocFiles.map((file) => file.filename).join(", ");
      return changedBaselineFiles.map((file) =>
        baselineFinding(
          ctx,
          file.filename,
          `Baseline updates can only be approved when the PR changes baseline files and related docs; also changed: ${changedFiles}. CODEOWNER approval and labels cannot downgrade mixed source/config changes.`
        )
      );
    }

    const codeowners = await readCodeowners(ctx);
    if (!codeowners) {
      return changedBaselineFiles.map((file) =>
        baselineFinding(ctx, file.filename, "CODEOWNERS file is missing; baseline changes are blocked fail-closed.")
      );
    }

    const provider = ctx.codeOwnerReviewProvider ?? (ctx.github ? createGitHubReviewProvider(ctx.github) : undefined);
    if (!provider) {
      return changedBaselineFiles.map((file) =>
        baselineFinding(ctx, file.filename, "PR review API is unavailable; CODEOWNER approval could not be verified.")
      );
    }

    let reviews: PullRequestReview[];
    try {
      reviews = await provider.listReviews();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return changedBaselineFiles.map((file) =>
        baselineFinding(ctx, file.filename, `PR reviews API failed; CODEOWNER approval could not be verified: ${message}`)
      );
    }

    const findings: Finding[] = [];
    for (const file of changedBaselineFiles) {
      const owners = findCodeOwnersForFile(codeowners.source, file.filename);
      if (owners.length === 0) {
        findings.push(baselineFinding(ctx, file.filename, "No CODEOWNERS entry matches this baseline file."));
        continue;
      }

      const approval = await hasCodeOwnerApproval(owners, reviews, provider, options.codeownerTeamFallback);
      if (!approval.ok) {
        findings.push(
          baselineFinding(
            ctx,
            file.filename,
            `${approval.reason} ${labelHint(ctx)}`.trim()
          )
        );
        continue;
      }

      findings.push({
        detector: baselineChangeDetector.id,
        severity: "info",
        ruleId: "false-clean-pass/baseline-change-approved",
        file: file.filename,
        message: `Baseline file changed with verified CODEOWNER approval from @${approval.reviewer}. ${labelHint(ctx)}`.trim()
      });
    }

    return findings;
  }
};

async function readCodeowners(ctx: DetectorContext): Promise<{ path: string; source: string } | undefined> {
  for (const path of codeownersPaths) {
    if (await ctx.fileExists(path)) {
      return {
        path,
        source: await ctx.readFile(path)
      };
    }
  }
  return undefined;
}

async function hasCodeOwnerApproval(
  owners: string[],
  reviews: PullRequestReview[],
  provider: CodeOwnerReviewProvider,
  codeownerTeamFallback: boolean
): Promise<{ ok: true; reviewer: string } | { ok: false; reason: string }> {
  const latest = latestReviewsByUser(reviews);
  const approvedReviews = [...latest.values()].filter((review) => review.state.toUpperCase() === "APPROVED");
  const approvedReviewers = approvedReviews.map((review) => review.user);

  for (const owner of owners) {
    const normalized = owner.replace(/^@/, "");
    if (!normalized.includes("/")) {
      const reviewer = approvedReviewers.find((user) => user.toLowerCase() === normalized.toLowerCase());
      if (reviewer) {
        return { ok: true, reviewer };
      }
      continue;
    }

    const [teamOwner, teamSlug] = normalized.split("/");
    if (!teamOwner || !teamSlug || !codeownerTeamFallback) {
      continue;
    }

    if (provider.isTeamMember) {
      for (const reviewer of approvedReviewers) {
        const isMember = await provider.isTeamMember(teamOwner, teamSlug, reviewer);
        if (isMember) {
          return { ok: true, reviewer };
        }
      }
    }

    const fallbackReview = approvedReviews.find((review) => isTrustedTeamFallbackAssociation(review.authorAssociation));
    if (fallbackReview) {
      return { ok: true, reviewer: fallbackReview.user };
    }
  }

  const teamOwners = owners.filter((owner) => owner.includes("/"));
  if (teamOwners.length > 0 && !codeownerTeamFallback) {
    return {
      ok: false,
      reason: `CODEOWNER is a team (${teamOwners.join(", ")}), but codeownerTeamFallback is disabled; blocking fail-closed.`
    };
  }

  return {
    ok: false,
    reason: `No approving PR review from matching CODEOWNER (${owners.join(", ")}) was verified.`
  };
}

function isTrustedTeamFallbackAssociation(authorAssociation: string | undefined): boolean {
  return authorAssociation === "OWNER" || authorAssociation === "MEMBER";
}

function latestReviewsByUser(reviews: PullRequestReview[]): Map<string, PullRequestReview> {
  const sorted = [...reviews].sort((left, right) => (left.submittedAt ?? "").localeCompare(right.submittedAt ?? ""));
  const latest = new Map<string, PullRequestReview>();
  for (const review of sorted) {
    latest.set(review.user.toLowerCase(), review);
  }
  return latest;
}

function baselineFinding(ctx: DetectorContext, file: string, message: string): Finding {
  return {
    detector: baselineChangeDetector.id,
    severity: ctx.config.baselineGuard.changeSeverity,
    ruleId: "false-clean-pass/baseline-change-unapproved",
    file,
    message
  };
}

function labelHint(ctx: DetectorContext): string {
  const label = ctx.config.baselineGuard.exemptLabel;
  return ctx.prLabels.includes(label)
    ? `Label ${label} is present but CODEOWNER approval remains authoritative.`
    : `Label ${label} is not present; label is only a secondary signal.`;
}

function isDocumentationFile(file: string): boolean {
  return /\.(?:md|mdx|rst|txt)$/i.test(file);
}
