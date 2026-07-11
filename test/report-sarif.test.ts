import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { createSarifLog } from "../src/report/sarif";
import type { RunResult } from "../src/core/types";

const sarifSchema = {
  type: "object",
  required: ["version", "$schema", "runs"],
  properties: {
    version: { const: "2.1.0" },
    $schema: { const: "https://json.schemastore.org/sarif-2.1.0.json" },
    runs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["tool", "results"],
        properties: {
          tool: {
            type: "object",
            required: ["driver"],
            properties: {
              driver: {
                type: "object",
                required: ["name", "rules"],
                properties: {
                  name: { const: "false-clean-pass" },
                  rules: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "shortDescription", "defaultConfiguration"]
                    }
                  }
                }
              }
            }
          },
          results: {
            type: "array",
            items: {
              type: "object",
              required: ["ruleId", "level", "message"],
              properties: {
                level: { enum: ["error", "warning", "note"] },
                message: {
                  type: "object",
                  required: ["text"]
                }
              }
            }
          }
        }
      }
    }
  }
};

describe("createSarifLog", () => {
  it("renders findings as SARIF 2.1.0 that validates against the schema", () => {
    const result: RunResult = {
      result: "fail",
      errorCount: 1,
      warningCount: 1,
      findings: [
        {
          detector: "skipped-tests",
          severity: "error",
          ruleId: "false-clean-pass/skipped-tests",
          file: "src/example.test.ts",
          line: 3,
          message: "Focused test was added."
        },
        {
          detector: "env-missing",
          severity: "warning",
          ruleId: "false-clean-pass/env-missing",
          message: "Declared key is not provided in CI."
        },
        {
          detector: "orchestrator",
          severity: "info",
          ruleId: "false-clean-pass/parse-failed",
          file: "src/broken.test.ts",
          message: "Parser skipped a file."
        }
      ]
    };

    const sarif = createSarifLog(result);
    const validate = new Ajv({ strict: false }).compile(sarifSchema);

    expect(validate(sarif)).toBe(true);
    expect(sarif.runs[0]?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "false-clean-pass/skipped-tests",
          level: "error",
          locations: [
            expect.objectContaining({
              physicalLocation: expect.objectContaining({
                artifactLocation: { uri: "src/example.test.ts" },
                region: { startLine: 3 }
              })
            })
          ]
        }),
        expect.objectContaining({
          ruleId: "false-clean-pass/parse-failed",
          level: "note"
        })
      ])
    );
  });
});
