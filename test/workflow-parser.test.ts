import { describe, expect, it } from "vitest";
import { parseWorkflow, parseWorkflowFiles } from "../src/parse/workflow-parser";

describe("workflowParser", () => {
  it("extracts triggers, job if, step lines, and matrix check names with include and exclude", () => {
    const workflow = parseWorkflow(
      `name: CI
on:
  pull_request:
    paths:
      - src/**
jobs:
  test:
    name: Tests
    if: github.event_name == 'pull_request'
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20]
        include:
          - os: macos-latest
            node: 20
        exclude:
          - os: windows-latest
            node: 20
    steps:
      - name: Run tests
        run: npm test
        continue-on-error: true
`
    );

    expect(workflow.on.events.pull_request?.paths).toEqual(["src/**"]);
    expect(workflow.jobs[0]).toEqual(
      expect.objectContaining({
        id: "test",
        name: "Tests",
        if: "github.event_name == 'pull_request'"
      })
    );
    expect(workflow.checkMappings.map((mapping) => mapping.checkName)).toEqual([
      "Tests (ubuntu-latest, 20)",
      "Tests (macos-latest, 20)"
    ]);
    expect(workflow.steps[0]).toEqual(
      expect.objectContaining({
        jobId: "test",
        stepName: "Run tests",
        continueOnError: true,
        continueOnErrorLine: 23
      })
    );
  });

  it("detects local reusable workflows, external reusable workflows, and dynamic names", () => {
    const workflows = parseWorkflowFiles({
      ".github/workflows/caller.yml": `on: pull_request
jobs:
  call-local:
    name: deploy
    uses: ./.github/workflows/reusable.yml
  call-external:
    uses: octo/example/.github/workflows/reusable.yml@v1
  dynamic:
    name: \${{ matrix.os }} build
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: npm test
`,
      ".github/workflows/reusable.yml": `on: workflow_call
jobs:
  build:
    name: build
    steps:
      - run: npm test
`
    });
    const caller = workflows.find((workflow) => workflow.file === ".github/workflows/caller.yml");

    expect(caller?.checkMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkName: "deploy / build",
          kind: "reusable",
          reusableWorkflow: ".github/workflows/reusable.yml"
        })
      ])
    );
    expect(caller?.unresolvedCheckMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: "call-external", reason: "external-reusable" }),
        expect.objectContaining({ jobId: "dynamic", reason: "dynamic-name" })
      ])
    );
  });
});
