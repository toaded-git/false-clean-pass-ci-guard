import type { CodeOwnerReviewProvider, GitHubRuntime, PullRequestReview } from "../core/types";

export function createGitHubReviewProvider(runtime: GitHubRuntime): CodeOwnerReviewProvider | undefined {
  const pullNumber = runtime.pullNumber;
  if (!pullNumber) {
    return undefined;
  }

  return {
    async listReviews(): Promise<PullRequestReview[]> {
      const github = await import("@actions/github");
      const octokit = github.getOctokit(runtime.token);
      const reviews = (await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner: runtime.owner,
        repo: runtime.repo,
        pull_number: pullNumber,
        per_page: 100
      })) as Array<{
        user?: { login?: string };
        state?: string;
        submitted_at?: string | null;
        author_association?: string;
      }>;

      return reviews
        .filter((review) => review.user?.login)
        .map((review) => ({
          user: review.user?.login ?? "",
          state: review.state ?? "",
          submittedAt: review.submitted_at ?? undefined,
          authorAssociation: review.author_association
        }));
    },
    async isTeamMember(teamOwner: string, teamSlug: string, username: string): Promise<boolean | undefined> {
      const github = await import("@actions/github");
      const octokit = github.getOctokit(runtime.token);
      try {
        const response = await octokit.rest.teams.getMembershipForUserInOrg({
          org: teamOwner,
          team_slug: teamSlug,
          username
        });
        return response.data.state === "active";
      } catch {
        return undefined;
      }
    }
  };
}
