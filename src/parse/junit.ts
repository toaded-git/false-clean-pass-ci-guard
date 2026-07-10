import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface TestCountSummary {
  tests: number;
  skipped: number;
  failures: number;
  errors: number;
  executed: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true
});

export function parseJUnitXml(source: string): TestCountSummary {
  const validation = XMLValidator.validate(source);
  if (validation !== true) {
    throw new Error(`Invalid JUnit XML: ${validation.err.msg}`);
  }

  const document = parser.parse(source) as unknown;
  const suites = collectSuites(document);
  const totals = suites.reduce<{ tests: number; skipped: number; failures: number; errors: number }>(
    (acc, suite) => {
      acc.tests += numericAttribute(suite.tests);
      acc.skipped += numericAttribute(suite.skipped);
      acc.failures += numericAttribute(suite.failures);
      acc.errors += numericAttribute(suite.errors);
      return acc;
    },
    { tests: 0, skipped: 0, failures: 0, errors: 0 }
  );

  return {
    ...totals,
    executed: Math.max(0, totals.tests - totals.skipped)
  };
}

export function addTestCountSummaries(summaries: TestCountSummary[]): TestCountSummary {
  const totals = summaries.reduce(
    (acc, summary) => {
      acc.tests += summary.tests;
      acc.skipped += summary.skipped;
      acc.failures += summary.failures;
      acc.errors += summary.errors;
      acc.executed += summary.executed;
      return acc;
    },
    { tests: 0, skipped: 0, failures: 0, errors: 0, executed: 0 }
  );

  return totals;
}

function collectSuites(value: unknown): Array<Record<string, unknown>> {
  const suites: Array<Record<string, unknown>> = [];
  visit(value, (node, key) => {
    if (key === "testsuite" && isRecord(node)) {
      suites.push(node);
    }
  });
  if (suites.length === 0 && isRecord(value)) {
    const rootSuite = isRecord(value.testsuites) ? value.testsuites : undefined;
    if (rootSuite && numericAttribute(rootSuite.tests) > 0) {
      suites.push(rootSuite);
    }
  }
  return suites;
}

function visit(value: unknown, visitor: (node: unknown, key?: string) => void, key?: string): void {
  visitor(value, key);
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, visitor, key);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    visit(childValue, visitor, childKey);
  }
}

function numericAttribute(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
