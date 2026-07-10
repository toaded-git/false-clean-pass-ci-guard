import type { Finding } from "../core/types";

export async function emitAnnotations(findings: Finding[]): Promise<void> {
  const core = await import("@actions/core");

  for (const finding of findings) {
    const properties =
      finding.file && finding.line
        ? {
            file: finding.file,
            startLine: finding.line,
            title: finding.ruleId
          }
        : {
            title: finding.ruleId
          };

    if (finding.severity === "error") {
      core.error(finding.message, properties);
    } else if (finding.severity === "warning") {
      core.warning(finding.message, properties);
    } else {
      core.notice(finding.message, properties);
    }
  }
}
