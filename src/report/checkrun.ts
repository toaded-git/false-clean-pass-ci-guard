import type { RunResult } from "../core/types";
import { FALSE_CLEAN_PASS_CHECK_NAME, formatCheckRunShaMarker } from "../gh/checkrun";

export interface CheckRunOptions {
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  result: RunResult;
  checkRunId?: number;
}

export function formatCheckRunSummary(result: RunResult, headSha?: string): string {
  const marker = headSha ? `${formatCheckRunShaMarker(headSha)}\n\n` : "";
  if (result.findings.length === 0) {
    return `${marker}No false-clean-pass findings were detected.`;
  }

  const lines = [
    marker.trimEnd(),
    `Result: ${result.result}`,
    `Errors: ${result.errorCount}`,
    `Warnings: ${result.warningCount}`,
    "",
    "| Severity | Rule | Location | Message |",
    "| --- | --- | --- | --- |"
  ];

  for (const finding of result.findings) {
    const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push(`| ${finding.severity} | ${finding.ruleId} | ${location} | ${escapeMarkdownCell(finding.message)} |`);
  }

  return lines.filter((line, index) => index !== 0 || line.length > 0).join("\n");
}

export async function createCheckRun(options: CheckRunOptions): Promise<void> {
  const github = await import("@actions/github");
  const octokit = github.getOctokit(options.token);
  const payload = {
    owner: options.owner,
    repo: options.repo,
    status: "completed" as const,
    conclusion: (options.result.result === "pass" ? "success" : "failure") as "success" | "failure",
    output: {
      title: FALSE_CLEAN_PASS_CHECK_NAME,
      summary: formatCheckRunSummary(options.result, options.headSha),
      annotations: options.result.findings
        .filter((finding) => finding.file && finding.line)
        .slice(0, 50)
        .map((finding) => ({
          path: finding.file as string,
          start_line: finding.line as number,
          end_line: finding.line as number,
          annotation_level: annotationLevel(finding.severity),
          message: finding.message
        }))
    }
  };

  if (options.checkRunId) {
    await octokit.rest.checks.update({
      ...payload,
      check_run_id: options.checkRunId
    });
    return;
  }

  await octokit.rest.checks.create({
    ...payload,
    name: FALSE_CLEAN_PASS_CHECK_NAME,
    head_sha: options.headSha
  });
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function annotationLevel(severity: "error" | "warning" | "info"): "failure" | "warning" | "notice" {
  if (severity === "error") {
    return "failure";
  }
  return severity === "warning" ? "warning" : "notice";
}
