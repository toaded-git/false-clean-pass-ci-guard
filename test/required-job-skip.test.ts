import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { requiredJobSkipDetector } from "../src/detectors/requiredJobSkip";
import type { Finding, RunResult } from "../src/core/types";
import { createEvidenceRecord } from "../src/core/evidenceRecord";
import { contextForRoot, diffFile, makeVerifyTempDir, repoRoot } from "./helpers";

const ciFile = ".github/workflows/ci.yml";

describe("required job skip detector", () => {
  it("hard-fails a required job skip-risk actor exclusion if", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: {
        [ciFile]: workflow({ job: "test" })
      },
      head: {
        [ciFile]: workflow({ job: "test", jobIf: "github.actor != 'x'" })
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          ruleId: "false-clean-pass/required_job_if_skip_risk"
        })
      ])
    );
  });

  it("hard-fails a required job name change with a confirmed base mapping", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: {
        [ciFile]: workflow({ job: "unit", name: "test" })
      },
      head: {
        [ciFile]: workflow({ job: "unit", name: "unit" })
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          ruleId: "false-clean-pass/required_job_missing"
        })
      ])
    );
  });

  it("hard-fails pull_request paths-ignore expansion as trigger narrowing", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: {
        [ciFile]: workflow({ job: "test" })
      },
      head: {
        [ciFile]: `name: ci
on:
  pull_request:
    paths-ignore:
      - docs/**
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          ruleId: "false-clean-pass/required_workflow_trigger_narrowed",
          message: expect.stringContaining("manual confirmation")
        })
      ])
    );
  });

  it("hard-fails with.requiredJobs narrowing", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: {
        [ciFile]: guardWorkflow("test,lint")
      },
      head: {
        [ciFile]: guardWorkflow("test")
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          ruleId: "false-clean-pass/required_config_narrowed",
          message: expect.stringContaining("lint")
        })
      ])
    );
  });

  it("maps same-repo reusable workflows and hard-fails when the inner required job disappears", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["deploy / build"],
      base: {
        [ciFile]: callerWorkflow("./.github/workflows/reusable.yml"),
        ".github/workflows/reusable.yml": reusableWorkflow("build")
      },
      head: {
        [ciFile]: callerWorkflow("./.github/workflows/reusable.yml"),
        ".github/workflows/reusable.yml": `on: workflow_call
jobs: {}
`
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          ruleId: "false-clean-pass/required_job_missing"
        })
      ])
    );
  });

  it("warns instead of hard-failing when required mapping is behind an external reusable workflow", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["deploy / build"],
      base: {
        [ciFile]: callerWorkflow("octo/example/.github/workflows/reusable.yml@v1")
      },
      head: {
        [ciFile]: callerWorkflow("octo/example/.github/workflows/reusable.yml@v1")
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          ruleId: "false-clean-pass/mapping_unresolved"
        })
      ])
    );
    expect(findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "false-clean-pass/required_job_missing" })])
    );
  });

  it("hard-fails matrix combination removal and passes matrix combination additions", async () => {
    const removed = await runRequiredJobCase({
      requiredJobs: ["Test (ubuntu-latest)", "Test (windows-latest)"],
      base: {
        [ciFile]: matrixWorkflow(["ubuntu-latest", "windows-latest"])
      },
      head: {
        [ciFile]: matrixWorkflow(["ubuntu-latest", "windows-latest"], "windows-latest")
      }
    });
    expect(removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          ruleId: "false-clean-pass/required_job_missing",
          message: expect.stringContaining("windows-latest")
        })
      ])
    );

    const added = await runRequiredJobCase({
      requiredJobs: ["Test (ubuntu-latest)"],
      base: {
        [ciFile]: matrixWorkflow(["ubuntu-latest"])
      },
      head: {
        [ciFile]: matrixWorkflow(["ubuntu-latest", "windows-latest"])
      }
    });
    expect(errorRuleIds(added)).toEqual([]);
  });

  it("warns instead of hard-failing for dynamic job names", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["ubuntu-build"],
      base: {
        [ciFile]: dynamicNameWorkflow()
      },
      head: {
        [ciFile]: dynamicNameWorkflow()
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          ruleId: "false-clean-pass/mapping_unresolved"
        })
      ])
    );
    expect(findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "false-clean-pass/required_job_missing" })])
    );
  });

  it("passes legitimate conditional if expressions", async () => {
    const refCondition = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: {
        [ciFile]: workflow({ job: "test" })
      },
      head: {
        [ciFile]: workflow({ job: "test", jobIf: "github.ref == 'refs/heads/main'" })
      }
    });
    expect(errorRuleIds(refCondition)).toEqual([]);
    expect(warningRuleIds(refCondition)).toEqual([]);

    const needsCondition = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: {
        [ciFile]: workflow({ job: "test" })
      },
      head: {
        [ciFile]: workflow({ job: "test", jobIf: "success() && needs.build.result == 'success'" })
      }
    });
    expect(errorRuleIds(needsCondition)).toEqual([]);
    expect(warningRuleIds(needsCondition)).toEqual([]);
  });

  it("records ambiguous required job if additions as review warnings", async () => {
    const findings = await runRequiredJobCase({
      requiredJobs: ["lint"],
      base: {
        [ciFile]: workflow({ job: "lint" })
      },
      head: {
        [ciFile]: workflow({ job: "lint", jobIf: "vars.RUN_LINT == 'true'" })
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          ruleId: "false-clean-pass/required_job_if_added_review"
        })
      ])
    );
    expect(errorRuleIds(findings)).toEqual([]);
  });

  it("produces M2 unsigned evidence metadata for hard-fail, review, and unresolved mapping findings", async () => {
    const hardFail = await runRequiredJobCase({
      requiredJobs: ["test"],
      base: { [ciFile]: workflow({ job: "test" }) },
      head: { [ciFile]: workflow({ job: "test", jobIf: "github.actor != 'x'" }) }
    });
    const review = await runRequiredJobCase({
      requiredJobs: ["lint"],
      base: { [ciFile]: workflow({ job: "lint" }) },
      head: { [ciFile]: workflow({ job: "lint", jobIf: "vars.RUN_LINT == 'true'" }) }
    });
    const unresolved = await runRequiredJobCase({
      requiredJobs: ["deploy / build"],
      base: { [ciFile]: callerWorkflow("octo/example/.github/workflows/reusable.yml@v1") },
      head: { [ciFile]: callerWorkflow("octo/example/.github/workflows/reusable.yml@v1") }
    });

    const result = toRunResult([...hardFail, ...review, ...unresolved]);
    const record = createEvidenceRecord({
      result,
      repo: "owner/repo",
      prNumber: 123,
      headSha: "abcdef",
      baseSha: "012345",
      actor: "login",
      runId: "9876543210",
      timestamp: "2026-07-11T09:00:00Z"
    });

    expect(record.license).toEqual({
      org: false,
      licenseId: null,
      signaturePresent: false
    });
    expect(record.signature).toBeNull();
    expect(record.attempts.map((attempt) => attempt.kind)).toEqual(
      expect.arrayContaining(["required_job_if_skip_risk", "required_job_if_added_review"])
    );
    expect(record.weakenings.map((weakening) => weakening.kind)).toEqual(expect.arrayContaining(["mapping_unresolved"]));

    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/evidence-record.schema.json"), "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(record), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

async function runRequiredJobCase(options: {
  requiredJobs: string[];
  base: Record<string, string>;
  head: Record<string, string>;
}): Promise<Finding[]> {
  const root = makeVerifyTempDir("required-job-");
  try {
    for (const [file, source] of Object.entries(options.head)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), source);
    }

    const changedFiles = [...new Set([...Object.keys(options.base), ...Object.keys(options.head)])];
    const ctx = contextForRoot(
      root,
      changedFiles.map((file) =>
        diffFile(
          file,
          `@@ -1,1 +1,1 @@
-old
+new
`
        )
      ),
      {
        detectors: {
          requiredJobSkip: {
            requiredJobs: options.requiredJobs
          }
        }
      },
      {
        listFiles: async () => Object.keys(options.head),
        readBaseFile: async (file) => {
          const source = options.base[file];
          if (source === undefined) {
            throw new Error(`No base file: ${file}`);
          }
          return source;
        }
      }
    );

    return await requiredJobSkipDetector.run(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function workflow(options: { job: string; name?: string; jobIf?: string }): string {
  return `name: ci
on: pull_request
jobs:
  ${options.job}:
    ${options.name ? `name: ${options.name}\n    ` : ""}${options.jobIf ? `if: ${options.jobIf}\n    ` : ""}runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
}

function guardWorkflow(requiredJobs: string): string {
  return `name: false-clean-pass
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/false-clean-pass-ci-guard@v1
        with:
          requiredJobs: "${requiredJobs}"
`;
}

function callerWorkflow(uses: string): string {
  return `name: deploy
on: pull_request
jobs:
  call:
    name: deploy
    uses: ${uses}
`;
}

function reusableWorkflow(job: string): string {
  return `on: workflow_call
jobs:
  ${job}:
    name: ${job}
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
}

function matrixWorkflow(osValues: string[], excludedOs?: string): string {
  return `name: ci
on: pull_request
jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [${osValues.join(", ")}]
${excludedOs ? `        exclude:\n          - os: ${excludedOs}\n` : ""}    steps:
      - run: npm test
`;
}

function dynamicNameWorkflow(): string {
  return `name: ci
on: pull_request
jobs:
  build:
    name: \${{ matrix.os }}-build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu]
    steps:
      - run: npm test
`;
}

function errorRuleIds(findings: Finding[]): string[] {
  return findings.filter((finding) => finding.severity === "error").map((finding) => finding.ruleId);
}

function warningRuleIds(findings: Finding[]): string[] {
  return findings.filter((finding) => finding.severity === "warning").map((finding) => finding.ruleId);
}

function toRunResult(findings: Finding[]): RunResult {
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  return {
    findings,
    errorCount,
    warningCount,
    result: errorCount > 0 ? "fail" : "pass"
  };
}
