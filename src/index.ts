import { loadConfig, type GuardConfig } from "./config/schema";
import { createDetectorContext, type DetectorContextOptions } from "./core/context";
import { runGuard } from "./core/orchestrator";
import type { FailOn, GitHubRuntime } from "./core/types";
import { getGitHubDiff, getLocalGitDiff } from "./git/diff";
import { createCheckRunAttestationVerifier, emitCheckRunShaMarker } from "./gh/checkrun";
import { createGitHubReviewProvider } from "./gh/reviews";
import { emitAnnotations } from "./report/annotations";
import { createCheckRun } from "./report/checkrun";
import { type CommentMode, upsertPullRequestComment } from "./report/comment";
import { writeSarifLogFile } from "./report/sarif";

export async function runAction(): Promise<void> {
  const core = await import("@actions/core");
  const rootDir = process.cwd();
  const configPath = core.getInput("config-path") || ".github/false-clean-pass.yml";
  const failOnInput = parseFailOn(core.getInput("fail-on"));
  const sarifPath = core.getInput("sarif-path") || core.getInput("sarif-output") || "false-clean-pass.sarif";
  const commentMode = parseCommentMode(core.getInput("comment-mode"));
  const attestationMode = parseAttestationMode(core.getInput("attestation-mode"));
  const token = core.getInput("github-token");
  const config = applyInputConfigOverrides(loadConfig(rootDir, configPath), {
    testCountBaseline: core.getInput("test-count-baseline"),
    allowContinueOnErrorSteps: splitCommaList(core.getInput("allow-continue-on-error-steps")),
    codeownerTeamFallback: parseBooleanInput(core.getInput("codeowner-team-fallback"))
  });
  const diff = await getActionDiff(rootDir, token);
  const runtime = await getGitHubRuntime(token);
  const markerCheckRunId = runtime && attestationMode === "marker" ? await tryEmitCheckRunMarker(runtime) : undefined;
  const contextOptions = await buildContextOptions(core, runtime, attestationMode);
  const result = await runGuard(createDetectorContext(rootDir, config, diff, contextOptions), failOnInput ?? config.failOn);

  await writeSarifLogFile(result, { rootDir, sarifPath });
  await emitAnnotations(result.findings);
  core.setOutput("result", result.result);
  core.setOutput("error-count", String(result.errorCount));
  core.setOutput("warning-count", String(result.warningCount));
  core.setOutput("sarif-path", sarifPath);

  await tryCreateCheckRun(token, result, markerCheckRunId);
  await tryUpsertPullRequestComment(token, result, sarifPath, commentMode);

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

async function tryUpsertPullRequestComment(
  token: string,
  result: Awaited<ReturnType<typeof runGuard>>,
  sarifPath: string,
  mode: CommentMode
): Promise<void> {
  const [core, github] = await Promise.all([import("@actions/core"), import("@actions/github")]);
  const pullNumber = github.context.payload.pull_request?.number;
  if (!token || !pullNumber || mode === "off") {
    return;
  }

  try {
    await upsertPullRequestComment({
      token,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pullNumber,
      result,
      sarifPath,
      mode
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Unable to upsert false-clean-pass PR comment: ${message}`);
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

async function buildContextOptions(
  core: { getInput(name: string): string },
  runtime: GitHubRuntime | undefined,
  attestationMode: AttestationMode
): Promise<DetectorContextOptions> {
  return {
    ciEnvKeys: splitCommaList(core.getInput("ci-env-keys")),
    testResultsGlob: core.getInput("test-results-glob") || undefined,
    baseTestResultsGlob: core.getInput("base-test-results-glob") || undefined,
    coverageSummaryPath: core.getInput("coverage-summary") || undefined,
    prLabels: await getPullRequestLabels(),
    github: runtime,
    codeOwnerReviewProvider: runtime ? createGitHubReviewProvider(runtime) : undefined,
    checkRunAttestationVerifier:
      runtime && attestationMode === "marker" ? createCheckRunAttestationVerifier(runtime) : undefined
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

function parseCommentMode(value: string): CommentMode {
  if (value === "new" || value === "off") {
    return value;
  }
  return "update";
}

type AttestationMode = "marker" | "off";

function parseAttestationMode(value: string): AttestationMode {
  return value === "off" ? "off" : "marker";
}

function applyInputConfigOverrides(
  config: GuardConfig,
  options: {
    testCountBaseline?: string;
    allowContinueOnErrorSteps?: string[];
    codeownerTeamFallback?: boolean;
  }
): GuardConfig {
  let next = config;

  if (options.testCountBaseline) {
    next = {
      ...next,
      testCountRatchet: {
        ...next.testCountRatchet,
        baselineFile: options.testCountBaseline
      }
    };
  }

  if (options.allowContinueOnErrorSteps && options.allowContinueOnErrorSteps.length > 0) {
    next = {
      ...next,
      detectors: {
        ...next.detectors,
        ignoredFailures: {
          ...next.detectors.ignoredFailures,
          allowContinueOnErrorSteps: options.allowContinueOnErrorSteps
        }
      }
    };
  }

  if (options.codeownerTeamFallback !== undefined) {
    const baselineGuard = {
      ...next.baselineGuard,
      codeownerTeamFallback: options.codeownerTeamFallback
    };
    next = {
      ...next,
      baselineGuard,
      detectors: {
        ...next.detectors,
        baselineGuard
      }
    };
  }

  return next;
}

function parseBooleanInput(value: string): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

void runAction();
