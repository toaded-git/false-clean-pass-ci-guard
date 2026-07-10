import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envMissingDetector } from "../src/detectors/env-missing";
import { contextForRoot, diffFile, makeVerifyTempDir } from "./helpers";

describe("envMissingDetector", () => {
  it("reports required missing env keys and undeclared refs as errors while keeping optional refs informational", async () => {
    const root = makeVerifyTempDir("env-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/app.ts"),
      `
const token = process.env.JWT_SECRET;
const api = process.env.API_URL;
const optional = process.env.OPTIONAL_KEY;
const dynamic = process.env[envName];
`
    );

    const findings = await envMissingDetector.run(
      contextForRoot(
        root,
        [
          diffFile(
            "src/app.ts",
            `@@ -1,0 +1,4 @@
+const token = process.env.JWT_SECRET;
+const api = process.env.API_URL;
+const optional = process.env.OPTIONAL_KEY;
+const dynamic = process.env[envName];
`
          )
        ],
        {
          detectors: {
            envMissing: {
              required: ["JWT_SECRET"],
              optional: ["OPTIONAL_KEY"]
            }
          }
        }
      )
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", ruleId: "false-clean-pass/env-required-missing" }),
        expect.objectContaining({ severity: "error", ruleId: "false-clean-pass/env-missing", file: "src/app.ts" }),
        expect.objectContaining({ severity: "info", ruleId: "false-clean-pass/env-missing", file: "src/app.ts" }),
        expect.objectContaining({ severity: "info", ruleId: "false-clean-pass/env-dynamic-access" })
      ])
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults code references missing from env examples and ci-env-keys to errors", async () => {
    const root = makeVerifyTempDir("env-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/payments.ts"), "const stripe = process.env.STRIPE_SECRET;\n");

    const findings = await envMissingDetector.run(
      contextForRoot(root, [
        diffFile(
          "src/payments.ts",
          `@@ -1,0 +1,1 @@
+const stripe = process.env.STRIPE_SECRET;
`
        )
      ])
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        ruleId: "false-clean-pass/env-missing",
        file: "src/payments.ts"
      })
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("honors the default allowlist and ci-env-keys", async () => {
    const root = makeVerifyTempDir("env-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/app.ts"),
      `
process.env.NODE_ENV;
process.env.DATABASE_URL;
`
    );

    const findings = await envMissingDetector.run(
      contextForRoot(
        root,
        [
          diffFile(
            "src/app.ts",
            `@@ -1,0 +1,2 @@
+process.env.NODE_ENV;
+process.env.DATABASE_URL;
`
          )
        ],
        {},
        { ciEnvKeys: ["DATABASE_URL"] }
      )
    );

    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
