import type { Finding, RunResult } from "../core/types";

export const PR_COMMENT_MARKER = "<!-- false-clean-pass:pr-comment -->";

export type CommentMode = "update" | "new" | "off";

export interface PullRequestCommentRuntime {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface UpsertCommentOptions extends PullRequestCommentRuntime {
  result: RunResult;
  sarifPath?: string;
  mode: CommentMode;
}

export interface UpsertCommentWithClientOptions {
  octokit: CommentOctokit;
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
  mode: CommentMode;
}

export interface PullRequestComment {
  id: number;
  body?: string | null;
}

export interface CommentOctokit {
  rest: {
    issues: {
      listComments(args: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }): Promise<{ data: PullRequestComment[] }>;
      updateComment(args: { owner: string; repo: string; comment_id: number; body: string }): Promise<unknown>;
      createComment(args: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
    };
  };
}

export type UpsertCommentResult = "created" | "updated" | "skipped";

export function formatPullRequestComment(result: RunResult, sarifPath?: string): string {
  const lines = [
    PR_COMMENT_MARKER,
    "## false-clean-pass",
    "",
    `Result: **${result.result}**`,
    "",
    "| Severity | Count |",
    "| --- | ---: |",
    `| error | ${result.errorCount} |`,
    `| warning | ${result.warningCount} |`,
    `| info | ${result.findings.filter((finding) => finding.severity === "info").length} |`,
    ""
  ];

  if (sarifPath) {
    lines.push(`SARIF: \`${sarifPath}\``, "");
  }

  if (result.findings.length === 0) {
    lines.push("No findings were detected.");
    return lines.join("\n");
  }

  lines.push("| Severity | Rule | Location | Message |", "| --- | --- | --- | --- |");
  for (const finding of result.findings.slice(0, 50)) {
    lines.push(
      `| ${finding.severity} | \`${finding.ruleId}\` | ${formatLocation(finding)} | ${escapeMarkdownCell(
        finding.message
      )} |`
    );
  }
  if (result.findings.length > 50) {
    lines.push(`| info | \`false-clean-pass/comment-truncated\` |  | ${result.findings.length - 50} more findings omitted. |`);
  }

  return lines.join("\n");
}

export async function upsertPullRequestComment(options: UpsertCommentOptions): Promise<UpsertCommentResult> {
  if (options.mode === "off") {
    return "skipped";
  }

  const github = await import("@actions/github");
  return upsertPullRequestCommentWithClient({
    octokit: github.getOctokit(options.token) as unknown as CommentOctokit,
    owner: options.owner,
    repo: options.repo,
    pullNumber: options.pullNumber,
    body: formatPullRequestComment(options.result, options.sarifPath),
    mode: options.mode
  });
}

export async function upsertPullRequestCommentWithClient(
  options: UpsertCommentWithClientOptions
): Promise<UpsertCommentResult> {
  if (options.mode === "off") {
    return "skipped";
  }

  if (options.mode === "update") {
    const comments = await options.octokit.rest.issues.listComments({
      owner: options.owner,
      repo: options.repo,
      issue_number: options.pullNumber,
      per_page: 100
    });
    const existing = comments.data.find((comment) => comment.body?.includes(PR_COMMENT_MARKER));
    if (existing) {
      await options.octokit.rest.issues.updateComment({
        owner: options.owner,
        repo: options.repo,
        comment_id: existing.id,
        body: options.body
      });
      return "updated";
    }
  }

  await options.octokit.rest.issues.createComment({
    owner: options.owner,
    repo: options.repo,
    issue_number: options.pullNumber,
    body: options.body
  });
  return "created";
}

function formatLocation(finding: Finding): string {
  if (!finding.file) {
    return "";
  }
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
