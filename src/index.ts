import { loadConfig } from "./config/schema";
import { createDetectorContext } from "./core/context";
import { runGuard } from "./core/orchestrator";
import type { FailOn } from "./core/types";
import { getGitHubDiff, getLocalGitDiff } from "./git/diff";
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
  const result = await runGuard(createDetectorContext(rootDir, config, diff), failOnInput ?? config.failOn);

  await emitAnnotations(result.findings);
  core.setOutput("result", result.result);
  core.setOutput("error-count", String(result.errorCount));
  core.setOutput("warning-count", String(result.warningCount));

  await tryCreateCheckRun(token, result);

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

async function tryCreateCheckRun(token: string, result: Awaited<ReturnType<typeof runGuard>>): Promise<void> {
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
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Unable to create false-clean-pass check run: ${message}`);
  }
}

function parseFailOn(value: string): FailOn | undefined {
  if (value === "error" || value === "warning" || value === "never") {
    return value;
  }
  return undefined;
}

void runAction();
