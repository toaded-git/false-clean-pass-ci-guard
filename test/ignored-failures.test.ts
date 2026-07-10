import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ignoredFailuresDetector } from "../src/detectors/ignored-failures";
import { contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("ignoredFailuresDetector", () => {
  it("reports newly added failure-ignore patterns", async () => {
    const root = makeVerifyTempDir("ignored-");
    const findings = await ignoredFailuresDetector.run(
      contextForRoot(root, [
        diffFile(
          ".github/workflows/ci.yml",
          `@@ -1,0 +1,3 @@
+        continue-on-error: true
+        run: npm test || true
+        run: npm test -- --passWithNoTests
`
        )
      ])
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "false-clean-pass/continue-on-error", severity: "error" }),
        expect.objectContaining({ ruleId: "false-clean-pass/ignore-failure-shell", severity: "error" }),
        expect.objectContaining({ ruleId: "false-clean-pass/pass-with-no-tests", severity: "error" })
      ])
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when check-run self-attestation is missing or on the wrong SHA", async () => {
    const root = makeVerifyTempDir("ignored-");
    const missing = await ignoredFailuresDetector.run(
      contextForRoot(root, [], {}, {
        checkRunAttestationVerifier: async () => ({
          ok: false,
          reason: "missing",
          message: "marker missing"
        })
      })
    );
    const mismatch = await ignoredFailuresDetector.run(
      contextForRoot(root, [], {}, {
        checkRunAttestationVerifier: async () => ({
          ok: false,
          reason: "sha-mismatch",
          message: "wrong SHA"
        })
      })
    );

    expect(missing).toEqual([expect.objectContaining({ ruleId: "false-clean-pass/checkrun-marker-missing" })]);
    expect(mismatch).toEqual([expect.objectContaining({ ruleId: "false-clean-pass/checkrun-sha-mismatch" })]);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports trigger, if, job-name, fail-on, and test-results-glob weakening", async () => {
    const root = makeVerifyTempDir("guard-");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      `
name: guard-disabled
on: push
jobs:
  guard:
    if: false
    steps:
      - uses: owner/false-clean-pass-ci-guard@v1
        with:
          fail-on: warning
`
    );

    const findings = await ignoredFailuresDetector.run(
      contextForRoot(root, [
        diffFile(
          ".github/workflows/ci.yml",
          `@@ -1,13 +1,12 @@
-name: false-clean-pass
+name: guard-disabled
 on:
-  pull_request:
+  push:
 jobs:
   guard:
+    if: false
     steps:
       - uses: owner/false-clean-pass-ci-guard@v1
         with:
-          fail-on: error
-          test-results-glob: junit.xml
+          fail-on: warning
`
        )
      ])
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "false-clean-pass/workflow-trigger-weakened" }),
        expect.objectContaining({ ruleId: "false-clean-pass/guard-if-weakened" }),
        expect.objectContaining({ ruleId: "false-clean-pass/guard-job-name-weakened" }),
        expect.objectContaining({ ruleId: "false-clean-pass/fail-on-weakened" }),
        expect.objectContaining({ ruleId: "false-clean-pass/test-results-glob-removed" })
      ])
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("does not report guard removal when the guard step moved to another workflow", async () => {
    const root = makeVerifyTempDir("guard-move-");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/new.yml"),
      `
jobs:
  guard:
    steps:
      - uses: owner/false-clean-pass-ci-guard@v1
`
    );

    const findings = await ignoredFailuresDetector.run(
      contextForRoot(root, [
        diffFile(
          ".github/workflows/old.yml",
          `@@ -1,4 +1,3 @@
 jobs:
   guard:
     steps:
-      - uses: owner/false-clean-pass-ci-guard@v1
`
        )
      ])
    );

    expect(findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "false-clean-pass/guard-step-removed" })]));
    rmSync(root, { recursive: true, force: true });
  });

  it("reports guard step removal when no replacement exists", async () => {
    const root = makeVerifyTempDir("guard-removed-");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/ci.yml"), "jobs:\n  guard:\n    steps: []\n");

    const findings = await ignoredFailuresDetector.run(
      contextForRoot(root, [
        diffFile(
          ".github/workflows/ci.yml",
          `@@ -1,4 +1,3 @@
 jobs:
   guard:
     steps:
-      - uses: owner/false-clean-pass-ci-guard@v1
`
        )
      ])
    );

    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "false-clean-pass/guard-step-removed" })]));
    rmSync(root, { recursive: true, force: true });
  });

  it("reports config required/enabled weakening", async () => {
    const root = makeVerifyTempDir("config-");
    const findings = await ignoredFailuresDetector.run(
      contextForRoot(root, [
        diffFile(
          ".github/false-clean-pass.yml",
          `@@ -1,5 +1,5 @@
 detectors:
   envMissing:
-    enabled: true
-    required: [JWT_SECRET]
+    enabled: false
+    required: []
`
        )
      ])
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "false-clean-pass/detector-disabled" }),
        expect.objectContaining({ ruleId: "false-clean-pass/required-list-weakened" })
      ])
    );
    rmSync(root, { recursive: true, force: true });
  });
});
