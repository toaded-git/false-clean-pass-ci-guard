import type { RunResult } from "../core/types";

export interface CheckRunOptions {
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  result: RunResult;
}

export function formatCheckRunSummary(result: RunResult): string {
  if (result.findings.length === 0) {
    return "No milestone 1 false-clean-pass findings were detected.";
  }

  const lines = [
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

  return lines.join("\n");
}

export async function createCheckRun(options: CheckRunOptions): Promise<void> {
  const github = await import("@actions/github");
  const octokit = github.getOctokit(options.token);
  await octokit.rest.checks.create({
    owner: options.owner,
    repo: options.repo,
    name: "false-clean-pass",
    head_sha: options.headSha,
    status: "completed",
    conclusion: options.result.result === "pass" ? "success" : "failure",
    output: {
      title: "false-clean-pass",
      summary: formatCheckRunSummary(options.result),
      annotations: options.result.findings
        .filter((finding) => finding.file && finding.line)
        .slice(0, 50)
        .map((finding) => ({
          path: finding.file as string,
          start_line: finding.line as number,
          end_line: finding.line as number,
          annotation_level: finding.severity === "error" ? "failure" : finding.severity === "warning" ? "warning" : "notice",
          message: finding.message
        }))
    }
  });
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
