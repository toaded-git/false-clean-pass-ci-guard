import { parse } from "@babel/parser";
import type * as t from "@babel/types";

export interface TestControlSignal {
  kind: "skip" | "focus";
  name: string;
  line: number;
  evidence: string;
}

export interface TestCaseSignal {
  line: number;
  evidence: string;
  emptyBody: boolean;
  returnOnly: boolean;
  assertionCount: number;
}

export interface JsScanResult {
  testControls: TestControlSignal[];
  testCases: TestCaseSignal[];
  parseFailed?: boolean;
  parseError?: string;
}

export function scanJavaScript(
  source: string,
  customAssertions: string[] = [],
  lenientAssertNames = true
): JsScanResult {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["typescript", "jsx", "decorators-legacy", "classProperties", "importMeta"]
    });
  } catch (error: unknown) {
    return parseFailureResult(error);
  }

  const lines = source.split(/\r?\n/);
  const testControls: TestControlSignal[] = [];
  const testCases: TestCaseSignal[] = [];

  traverse(ast.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }

    const control = getTestControlSignal(node);
    if (control) {
      testControls.push({
        ...control,
        line: getNodeLine(node),
        evidence: lineEvidence(lines, getNodeLine(node))
      });
    }

    const testCase = getTestCaseSignal(node, lines, customAssertions, lenientAssertNames);
    if (testCase) {
      testCases.push(testCase);
    }
  });

  return {
    testControls,
    testCases
  };
}

function getTestControlSignal(node: t.CallExpression): Pick<TestControlSignal, "kind" | "name"> | undefined {
  const callee = node.callee;

  if (callee.type === "Identifier") {
    if (callee.name === "xit" || callee.name === "xdescribe") {
      return { kind: "skip", name: callee.name };
    }
    if (callee.name === "fit" || callee.name === "fdescribe") {
      return { kind: "focus", name: callee.name };
    }
    return undefined;
  }

  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") {
    return undefined;
  }

  const rootName = getMemberRootName(callee);
  const propertyName = getMemberPropertyName(callee);
  if (!rootName || !["it", "test", "describe"].includes(rootName)) {
    return undefined;
  }

  if (propertyName === "skip") {
    return { kind: "skip", name: `${rootName}.skip` };
  }
  if (propertyName === "only") {
    return { kind: "focus", name: `${rootName}.only` };
  }
  return undefined;
}

function getTestCaseSignal(
  node: t.CallExpression,
  lines: string[],
  customAssertions: string[],
  lenientAssertNames: boolean
): TestCaseSignal | undefined {
  if (!isExecutableTestCall(node)) {
    return undefined;
  }

  const callback = node.arguments.find((argument): argument is t.ArrowFunctionExpression | t.FunctionExpression =>
    isFunctionNode(argument)
  );
  if (!callback) {
    return undefined;
  }

  const line = getNodeLine(node);
  return {
    line,
    evidence: lineEvidence(lines, line),
    emptyBody: isEmptyFunction(callback),
    returnOnly: isReturnOnlyFunction(callback),
    assertionCount: countAssertions(callback.body, customAssertions, lenientAssertNames)
  };
}

function isExecutableTestCall(node: t.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return callee.name === "it" || callee.name === "test";
  }

  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") {
    return false;
  }

  const rootName = getMemberRootName(callee);
  if (rootName !== "it" && rootName !== "test") {
    return false;
  }

  const propertyName = getMemberPropertyName(callee);
  return propertyName !== "skip" && propertyName !== "todo";
}

function countAssertions(node: t.Node | null | undefined, customAssertions: string[], lenientAssertNames: boolean): number {
  if (!node) {
    return 0;
  }

  let count = 0;
  traverse(node, (current, parent) => {
    if (current.type === "CallExpression" && isAssertionCall(current, customAssertions, lenientAssertNames)) {
      count += 1;
      return;
    }

    if (
      (current.type === "MemberExpression" || current.type === "OptionalMemberExpression") &&
      isAssertionPropertyAccess(current, parent)
    ) {
      count += 1;
    }
  });
  return count;
}

function isAssertionCall(node: t.CallExpression, customAssertions: string[], lenientAssertNames: boolean): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return (
      callee.name === "expect" ||
      callee.name === "assert" ||
      customAssertions.includes(callee.name) ||
      (lenientAssertNames && looksLikeAssertionName(callee.name))
    );
  }

  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") {
    return false;
  }

  const rootName = getMemberRootName(callee);
  const propertyName = getMemberPropertyName(callee);
  if (rootName === "expect" && (propertyName === "assertions" || propertyName === "hasAssertions")) {
    return true;
  }
  if (rootName === "assert") {
    return true;
  }
  if (rootName && customAssertions.includes(rootName)) {
    return true;
  }
  if (
    lenientAssertNames &&
    ((rootName && looksLikeAssertionName(rootName)) || (propertyName && looksLikeAssertionName(propertyName)))
  ) {
    return true;
  }

  return hasMemberProperty(callee, "should") || hasMemberProperty(callee, "to");
}

function looksLikeAssertionName(name: string): boolean {
  return /(?:^|[A-Z_])(assert|expect|should|verify)(?:$|[A-Z_])/i.test(name);
}

function isAssertionPropertyAccess(
  node: t.MemberExpression | t.OptionalMemberExpression,
  parent: t.Node | undefined
): boolean {
  if (parent?.type !== "ExpressionStatement") {
    return false;
  }

  const propertyName = getMemberPropertyName(node);
  if (!propertyName || propertyName === "should" || propertyName === "to") {
    return false;
  }

  return hasMemberProperty(node, "should") || hasMemberProperty(node, "to");
}

function parseFailureResult(error: unknown): JsScanResult {
  const result: JsScanResult = {
    testControls: [],
    testCases: []
  };

  Object.defineProperties(result, {
    parseFailed: {
      value: true
    },
    parseError: {
      value: error instanceof Error ? error.message : String(error)
    }
  });

  return result;
}

function isFunctionNode(node: t.Node | null | undefined): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function isEmptyFunction(node: t.ArrowFunctionExpression | t.FunctionExpression): boolean {
  return node.body.type === "BlockStatement" && node.body.body.length === 0;
}

function isReturnOnlyFunction(node: t.ArrowFunctionExpression | t.FunctionExpression): boolean {
  return node.body.type === "BlockStatement" && node.body.body.length === 1 && node.body.body[0]?.type === "ReturnStatement";
}

function hasMemberProperty(node: t.MemberExpression | t.OptionalMemberExpression, propertyName: string): boolean {
  if (getMemberPropertyName(node) === propertyName) {
    return true;
  }

  const object = node.object;
  if (object.type === "MemberExpression" || object.type === "OptionalMemberExpression") {
    return hasMemberProperty(object, propertyName);
  }
  if (object.type === "CallExpression") {
    const callee = object.callee;
    if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
      return hasMemberProperty(callee, propertyName);
    }
  }

  return false;
}

function getMemberRootName(node: t.MemberExpression | t.OptionalMemberExpression): string | undefined {
  const object = node.object;
  if (object.type === "Identifier") {
    return object.name;
  }
  if (object.type === "MemberExpression" || object.type === "OptionalMemberExpression") {
    return getMemberRootName(object);
  }
  if (object.type === "CallExpression") {
    const callee = object.callee;
    if (callee.type === "Identifier") {
      return callee.name;
    }
    if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
      return getMemberRootName(callee);
    }
  }
  return undefined;
}

function getMemberPropertyName(node: t.MemberExpression | t.OptionalMemberExpression): string | undefined {
  const property = node.property;
  if (property.type === "Identifier") {
    return property.name;
  }
  if (property.type === "StringLiteral") {
    return property.value;
  }
  return undefined;
}

function getNodeLine(node: t.Node): number {
  return node.loc?.start.line ?? 1;
}

function lineEvidence(lines: string[], line: number): string {
  return lines[line - 1]?.trim() ?? "";
}

function traverse(node: t.Node, visitor: (node: t.Node, parent?: t.Node) => void, parent?: t.Node): void {
  visitor(node, parent);

  const record = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isMetadataKey(key)) {
      continue;
    }

    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          traverse(item, visitor, node);
        }
      }
      continue;
    }

    if (isNode(value)) {
      traverse(value, visitor, node);
    }
  }
}

function isNode(value: unknown): value is t.Node {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

function isMetadataKey(key: string): boolean {
  return key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments");
}
