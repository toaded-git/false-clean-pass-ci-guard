import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/git/diff";

describe("parseUnifiedDiff", () => {
  it("collects added line numbers and content for a changed file", () => {
    const diff = parseUnifiedDiff(`diff --git a/src/example.test.ts b/src/example.test.ts
index 1111111..2222222 100644
--- a/src/example.test.ts
+++ b/src/example.test.ts
@@ -1,0 +1,2 @@
+test.only("focused", () => {})
+// eslint-disable-next-line no-console
`);

    expect(diff).toHaveLength(1);
    expect(diff[0]?.filename).toBe("src/example.test.ts");
    expect([...diff[0]!.addedLines]).toEqual([1, 2]);
    expect(diff[0]?.addedLineContent.get(2)).toBe("// eslint-disable-next-line no-console");
  });
});
