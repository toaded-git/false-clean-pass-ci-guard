import { describe, expect, it } from "vitest";
import {
  PR_COMMENT_MARKER,
  formatPullRequestComment,
  type CommentOctokit,
  upsertPullRequestCommentWithClient
} from "../src/report/comment";
import type { RunResult } from "../src/core/types";

describe("PR comment report", () => {
  it("updates the existing marker comment instead of creating a duplicate", async () => {
    const calls: string[] = [];
    const octokit: CommentOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [{ id: 10, body: `${PR_COMMENT_MARKER}\nold body` }]
          }),
          updateComment: async (args) => {
            calls.push(`update:${args.comment_id}:${args.body.includes("false-clean-pass")}`);
          },
          createComment: async () => {
            calls.push("create");
          }
        }
      }
    };

    const result = await upsertPullRequestCommentWithClient({
      octokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 5,
      mode: "update",
      body: formatPullRequestComment(sampleResult(), "false-clean-pass.sarif")
    });

    expect(result).toBe("updated");
    expect(calls).toEqual(["update:10:true"]);
  });

  it("creates a comment when no marker exists", async () => {
    const calls: string[] = [];
    const octokit: CommentOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [{ id: 1, body: "unrelated" }] }),
          updateComment: async () => {
            calls.push("update");
          },
          createComment: async (args) => {
            calls.push(`create:${args.issue_number}:${args.body.includes(PR_COMMENT_MARKER)}`);
          }
        }
      }
    };

    const result = await upsertPullRequestCommentWithClient({
      octokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 7,
      mode: "update",
      body: formatPullRequestComment(sampleResult())
    });

    expect(result).toBe("created");
    expect(calls).toEqual(["create:7:true"]);
  });
});

function sampleResult(): RunResult {
  return {
    result: "fail",
    errorCount: 1,
    warningCount: 0,
    findings: [
      {
        detector: "skipped-tests",
        severity: "error",
        ruleId: "false-clean-pass/skipped-tests",
        file: "src/example.test.ts",
        line: 1,
        message: "Focused test was added."
      }
    ]
  };
}
