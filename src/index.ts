import { loadConfig, type GuardConfig } from "./config/schema";
import { createDetectorContext, type DetectorContextOptions } from "./core/context";
import { createEvidenceRecord, writeEvidenceRecord } from "./core/evidenceRecord";
import { runGuard } from "./core/orchestrator";
import type { FailOn, GitHubRuntime } from "./core/types";
import { getGitHubDiff, getLocalGitDiff } from "./git/diff";
import { createCheckRunAttestationVerifier, emitCheckRunShaMarker } from "./gh/checkrun";
import { createGitHubReviewProvider } from "./gh/reviews";
import { verifyLicense, type LicenseVerificationResult } from "./license/verify";
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
  const evidenceOutput = core.getInput("evidenceOutput") || core.getInput("evidence-output") || "fcp-evidence.json";
  const licenseText = core.getInput("license") || process.env.FCP_LICENSE;
  const commentMode = parseCommentMode(core.getInput("comment-mode"));
  const attestationMode = parseAttestationMode(core.getInput("attestation-mode"));
  const token = core.getInput("github-token");
  const config = applyInputConfigOverrides(loadConfig(rootDir, configPath), {
    testCountBaseline: core.getInput("test-count-baseline"),
    allowContinueOnErrorSteps: splitCommaList(core.getInput("allow-continue-on-error-steps")),
    codeownerTeamFallback: parseBooleanInput(core.getInput("codeowner-team-fallback")),
    requiredJobs: splitCommaList(core.getInput("requiredJobs") || core.getInput("required-jobs")),
    evidenceOutput
  });
  const diff = await getActionDiff(rootDir, token);
  const runtime = await getGitHubRuntime(token);
  const markerCheckRunId = runtime && attestationMode === "marker" ? await tryEmitCheckRunMarker(runtime) : undefined;
  const contextOptions = await buildContextOptions(core, runtime, attestationMode);
  const result = await runGuard(createDetectorContext(rootDir, config, diff, contextOptions), failOnInput ?? config.failOn);
  const licenseVerification = resolveLicenseVerification(core, runtime, licenseText);
  const evidencePath = await writeEvidenceRecord(
    createEvidenceRecord({
      result,
      repo: runtime ? `${runtime.owner}/${runtime.repo}` : "local/local",
      prNumber: runtime?.pullNumber ?? null,
      headSha: runtime?.headSha ?? "local",
      baseSha: runtime?.baseSha ?? null,
      actor: runtime?.actor ?? "local",
      runId: runtime?.runId ?? null,
      ownerType: runtime?.ownerType,
      licenseVerification
    }),
    config.evidenceOutput,
    rootDir
  );

  await writeSarifLogFile(result, { rootDir, sarifPath });
  await emitAnnotations(result.findings);
  core.setOutput("result", result.result);
  core.setOutput("error-count", String(result.errorCount));
  core.setOutput("warning-count", String(result.warningCount));
  core.setOutput("sarif-path", sarifPath);
  core.setOutput("evidence-path", evidencePath);

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
    readBaseFile: runtime?.baseSha ? createGitHubBaseFileReader(runtime) : undefined,
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
    ownerType: getRepositoryOwnerType(github.context.payload),
    repo: github.context.repo.repo,
    headSha,
    baseSha: pullRequest?.base.sha,
    baseRef: pullRequest?.base.ref,
    actor: github.context.actor,
    runId: String(github.context.runId),
    pullNumber: pullRequest?.number
  };
}

function resolveLicenseVerification(
  core: { warning(message: string): void },
  runtime: GitHubRuntime | undefined,
  licenseText: string | undefined
): LicenseVerificationResult | undefined {
  if (runtime?.ownerType !== "Organization") {
    return undefined;
  }

  const result = verifyLicense(licenseText, { org: runtime.owner });
  if (!result.valid) {
    core.warning(`Organization Evidence Record signing disabled: ${result.message}`);
  }
  return result;
}

function getRepositoryOwnerType(payload: unknown): string | undefined {
  const repository = (payload as { repository?: { owner?: { type?: unknown } } } | undefined)?.repository;
  return typeof repository?.owner?.type === "string" ? repository.owner.type : undefined;
}

function createGitHubBaseFileReader(runtime: GitHubRuntime): (file: string) => Promise<string> {
  const baseSha = runtime.baseSha;
  if (!baseSha) {
    throw new Error("Base SHA is required to read base workflow files.");
  }

  return async (file: string) => {
    const github = await import("@actions/github");
    const octokit = github.getOctokit(runtime.token);
    const response = await octokit.rest.repos.getContent({
      owner: runtime.owner,
      repo: runtime.repo,
      path: file,
      ref: baseSha,
      mediaType: {
        format: "raw"
      }
    });

    if (typeof response.data === "string") {
      return response.data;
    }

    const content = (response.data as { content?: string; encoding?: string }).content;
    if (content) {
      return Buffer.from(content, "base64").toString("utf8");
    }

    throw new Error(`Base file is not readable as a file: ${file}`);
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
    requiredJobs?: string[];
    evidenceOutput?: string;
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

  if (options.requiredJobs && options.requiredJobs.length > 0) {
    next = {
      ...next,
      requiredJobs: options.requiredJobs,
      detectors: {
        ...next.detectors,
        requiredJobSkip: {
          ...next.detectors.requiredJobSkip,
          requiredJobs: options.requiredJobs
        }
      }
    };
  }

  if (options.evidenceOutput) {
    next = {
      ...next,
      evidenceOutput: options.evidenceOutput
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
