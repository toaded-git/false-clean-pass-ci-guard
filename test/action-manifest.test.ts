import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers";

// Guards against action.yml YAML errors (e.g. an unquoted colon inside a
// description value) that GitHub rejects at Action load time before any code runs.
describe("action.yml manifest", () => {
  const raw = readFileSync(resolve(repoRoot, "action.yml"), "utf8");

  it("parses as valid YAML", () => {
    expect(() => parse(raw)).not.toThrow();
  });

  it("has the required GitHub Action manifest fields", () => {
    const doc = parse(raw) as Record<string, unknown>;
    expect(typeof doc.name).toBe("string");
    expect(typeof doc.description).toBe("string");
    const runs = doc.runs as { using?: unknown; main?: unknown } | undefined;
    expect(runs?.using).toBeTruthy();
    expect(runs?.main).toBeTruthy();
    expect(doc.inputs !== null && typeof doc.inputs === "object").toBe(true);
  });
});
