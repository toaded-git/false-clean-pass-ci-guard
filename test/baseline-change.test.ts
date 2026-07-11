import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineChangeDetector } from "../src/detectors/baseline-change";
import type { CodeOwnerReviewProvider } from "../src/core/types";
import { contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("baselineChangeDetector", () => {
  it("downgrades baseline changes to info with verified user CODEOWNER approval", async () => {
    const root = baselineRepo("@alice");
    const provider: CodeOwnerReviewProvider = {
      listReviews: async () => [{ user: "alice", state: "APPROVED" }]
    };

    const findings = await baselineChangeDetector.run(contextForRoot(root, baselineDiff(), {}, { codeOwnerReviewProvider: provider }));

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "info",
        ruleId: "false-clean-pass/baseline-change-approved"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps baseline changes as errors when source files change with CODEOWNER approval and label", async () => {
    const root = baselineRepo("@alice");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const changed = true;\n");
    const provider: CodeOwnerReviewProvider = {
      listReviews: async () => [{ user: "alice", state: "APPROVED" }]
    };

    const findings = await baselineChangeDetector.run(
      contextForRoot(root, [...baselineDiff(), sourceDiff()], {}, { codeOwnerReviewProvider: provider, prLabels: ["baseline-update"] })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/baseline-change-unapproved"
      })
    ]);
    expect(findings[0]?.message).toContain("src/app.ts");
    expect(findings[0]?.message).toContain("cannot downgrade");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when approval is missing even if the baseline label is present", async () => {
    const root = baselineRepo("@alice");
    const provider: CodeOwnerReviewProvider = {
      listReviews: async () => [{ user: "bob", state: "APPROVED" }]
    };

    const findings = await baselineChangeDetector.run(
      contextForRoot(root, baselineDiff(), {}, { codeOwnerReviewProvider: provider, prLabels: ["baseline-update"] })
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/baseline-change-unapproved"
      })
    ]);
    expect(findings[0]?.message).toContain("Label baseline-update is present");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when CODEOWNERS is missing", async () => {
    const root = makeVerifyTempDir("baseline-");
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/false-clean-pass-coverage.json"), "{}");

    const findings = await baselineChangeDetector.run(contextForRoot(root, baselineDiff()));

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/baseline-change-unapproved"
      })
    ]);
    expect(findings[0]?.message).toContain("CODEOWNERS file is missing");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when PR reviews API fails", async () => {
    const root = baselineRepo("@alice");
    const provider: CodeOwnerReviewProvider = {
      listReviews: async () => {
        throw new Error("api unavailable");
      }
    };

    const findings = await baselineChangeDetector.run(contextForRoot(root, baselineDiff(), {}, { codeOwnerReviewProvider: provider }));

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/baseline-change-unapproved"
      })
    ]);
    expect(findings[0]?.message).toContain("api unavailable");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed for team CODEOWNER approval when team fallback is disabled", async () => {
    const root = baselineRepo("@org/security");
    const provider: CodeOwnerReviewProvider = {
      listReviews: async () => [{ user: "carol", state: "APPROVED" }],
      isTeamMember: async () => true
    };

    const blocked = await baselineChangeDetector.run(
      contextForRoot(root, baselineDiff(), {}, { codeOwnerReviewProvider: provider })
    );

    expect(blocked).toEqual([expect.objectContaining({ severity: "error" })]);
    expect(blocked[0]?.message).toContain("codeownerTeamFallback is disabled");
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts team CODEOWNER fallback only when explicitly enabled", async () => {
    const root = baselineRepo("@org/security");
    const provider: CodeOwnerReviewProvider = {
      listReviews: async () => [{ user: "carol", state: "APPROVED", authorAssociation: "MEMBER" }]
    };

    const approved = await baselineChangeDetector.run(
      contextForRoot(
        root,
        baselineDiff(),
        { baselineGuard: { codeownerTeamFallback: true } },
        { codeOwnerReviewProvider: provider }
      )
    );

    expect(approved).toEqual([expect.objectContaining({ severity: "info" })]);
    rmSync(root, { recursive: true, force: true });
  });
});

function baselineRepo(owner: string): string {
  const root = makeVerifyTempDir("baseline-");
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github/CODEOWNERS"), `.github/false-clean-pass-*.json ${owner}\n`);
  writeFileSync(join(root, ".github/false-clean-pass-coverage.json"), "{}");
  return root;
}

function baselineDiff() {
  return [
    diffFile(
      ".github/false-clean-pass-coverage.json",
      `@@ -1,1 +1,1 @@
-{"coverage": 85}
+{"coverage": 80}
`
    )
  ];
}

function sourceDiff() {
  return diffFile(
    "src/app.ts",
    `@@ -1,0 +1,1 @@
+export const changed = true;
`
  );
}
