import { loadConfig } from "./config/schema";
import { createDetectorContext, type DetectorContextOptions } from "./core/context";
import { runGuard } from "./core/orchestrator";
import type { FailOn, GitHubRuntime } from "./core/types";
import { getGitHubDiff, getLocalGitDiff } from "./git/diff";
import { createCheckRunAttestationVerifier, emitCheckRunShaMarker } from "./gh/checkrun";
import { createGitHubReviewProvider } from "./gh/reviews";
import { emitAnnotations } from "./report/annotations";
import { createCheckRun } from "./report/checkrun";

export async function runAction(): Promise<void> {
  const core = await import("@actions/core");
  const rootDir = process.cwd();
  const configPath = core.getInput("config-path") || ".github/false-clean-pass.yml";
  const failOnInput = parseFailOn(core.getInput("fail-on"));
  const token = core.getInput("github-token");
  const config = loadConfig(rootDir, configPath);
  const diff = await getActionDiff(rootDir, token);
  const runtime = await getGitHubRuntime(token);
  const markerCheckRunId = runtime ? await tryEmitCheckRunMarker(runtime) : undefined;
  const contextOptions = await buildContextOptions(core, runtime);
  const result = await runGuard(createDetectorContext(rootDir, config, diff, contextOptions), failOnInput ?? config.failOn);

  await emitAnnotations(result.findings);
  core.setOutput("result", result.result);
  core.setOutput("error-count", String(result.errorCount));
  core.setOutput("warning-count", String(result.warningCount));

  await tryCreateCheckRun(token, result, markerCheckRunId);

  if (result.result === "fail") {
    core.setFailed(`false-clean-pass detected ${result.errorCount} errors and ${result.warningCount} warnings.`);
  }
}

async function getActionDiff(rootDir: string, token: string) {
  const github = await import("@actions/github");
  const pullRequest = github.context.payload.pull_request;
  if (token && pullRequest) {
    return getGitHubDiff({
      token,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base: pullRequest.base.sha,
      head: pullRequest.head.sha
    });
  }

  const pushPayload = github.context.payload as { before?: string; after?: string };
  if (token && pushPayload.before && pushPayload.after) {
    return getGitHubDiff({
      token,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base: pushPayload.before,
      head: pushPayload.after
    });
  }

  return getLocalGitDiff(rootDir);
}

async function tryCreateCheckRun(
  token: string,
  result: Awaited<ReturnType<typeof runGuard>>,
  checkRunId?: number
): Promise<void> {
  const [core, github] = await Promise.all([import("@actions/core"), import("@actions/github")]);
  if (!token || !github.context.sha) {
    return;
  }

  try {
    await createCheckRun({
      token,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      headSha: github.context.payload.pull_request?.head.sha ?? github.context.sha,
      result,
      checkRunId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Unable to create false-clean-pass check run: ${message}`);
  }
}

async function tryEmitCheckRunMarker(runtime: GitHubRuntime): Promise<number | undefined> {
  const core = await import("@actions/core");
  try {
    return await emitCheckRunShaMarker(runtime);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Unable to emit false-clean-pass self-attestation marker: ${message}`);
    return undefined;
  }
}

async function buildContextOptions(core: { getInput(name: string): string }, runtime: GitHubRuntime | undefined): Promise<DetectorContextOptions> {
  return {
    ciEnvKeys: splitCommaList(core.getInput("ci-env-keys")),
    testResultsGlob: core.getInput("test-results-glob") || undefined,
    coverageSummaryPath: core.getInput("coverage-summary") || undefined,
    prLabels: await getPullRequestLabels(),
    github: runtime,
    codeOwnerReviewProvider: runtime ? createGitHubReviewProvider(runtime) : undefined,
    checkRunAttestationVerifier: runtime ? createCheckRunAttestationVerifier(runtime) : undefined
  };
}

async function getGitHubRuntime(token: string): Promise<GitHubRuntime | undefined> {
  if (!token) {
    return undefined;
  }
  const github = await import("@actions/github");
  const pullRequest = github.context.payload.pull_request;
  const headSha = pullRequest?.head.sha ?? github.context.sha;
  if (!headSha) {
    return undefined;
  }

  return {
    token,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    headSha,
    pullNumber: pullRequest?.number
  };
}

async function getPullRequestLabels(): Promise<string[]> {
  const github = await import("@actions/github");
  const labels = github.context.payload.pull_request?.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.map((label: { name?: string }) => label.name).filter((name): name is string => Boolean(name));
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFailOn(value: string): FailOn | undefined {
  if (value === "error" || value === "warning" || value === "never") {
    return value;
  }
  return undefined;
}

void runAction();
