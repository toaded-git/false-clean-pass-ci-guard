import type { CheckRunAttestationResult, CheckRunAttestationVerifier, GitHubRuntime } from "../core/types";

export const FALSE_CLEAN_PASS_CHECK_NAME = "false-clean-pass";

export function formatCheckRunShaMarker(headSha: string): string {
  return `<!-- false-clean-pass:self-attestation:${headSha} -->`;
}

export async function emitCheckRunShaMarker(runtime: GitHubRuntime): Promise<number | undefined> {
  const github = await import("@actions/github");
  const octokit = github.getOctokit(runtime.token);
  const response = await octokit.rest.checks.create({
    owner: runtime.owner,
    repo: runtime.repo,
    name: FALSE_CLEAN_PASS_CHECK_NAME,
    head_sha: runtime.headSha,
    status: "in_progress",
    output: {
      title: FALSE_CLEAN_PASS_CHECK_NAME,
      summary: formatCheckRunShaMarker(runtime.headSha)
    }
  });

  return response.data.id;
}

export function createCheckRunAttestationVerifier(runtime: GitHubRuntime): CheckRunAttestationVerifier {
  return async (): Promise<CheckRunAttestationResult> => {
    try {
      const github = await import("@actions/github");
      const octokit = github.getOctokit(runtime.token);
      const response = await octokit.rest.checks.listForRef({
        owner: runtime.owner,
        repo: runtime.repo,
        ref: runtime.headSha,
        check_name: FALSE_CLEAN_PASS_CHECK_NAME,
        per_page: 100
      });

      const marker = formatCheckRunShaMarker(runtime.headSha);
      const matching = response.data.check_runs.find((checkRun) => {
        const summary = checkRun.output?.summary ?? "";
        const text = checkRun.output?.text ?? "";
        return summary.includes(marker) || text.includes(marker);
      });

      if (!matching) {
        return {
          ok: false,
          reason: "missing",
          message: "false-clean-pass Check Run self-attestation marker was not found for this commit."
        };
      }

      if (matching.head_sha !== runtime.headSha) {
        return {
          ok: false,
          reason: "sha-mismatch",
          message: `false-clean-pass Check Run marker was found on ${matching.head_sha}, expected ${runtime.headSha}.`
        };
      }

      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        reason: "api-failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  };
}
