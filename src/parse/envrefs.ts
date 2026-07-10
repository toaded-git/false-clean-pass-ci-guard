import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { isJavaScriptLikeFile, isPythonFile } from "../core/globs";

export interface EnvReference {
  key?: string;
  dynamic: boolean;
  line: number;
  evidence: string;
}

export function extractEnvReferences(filename: string, source: string): EnvReference[] {
  if (isJavaScriptLikeFile(filename)) {
    return extractJavaScriptEnvReferences(source);
  }
  if (isPythonFile(filename)) {
    return extractPythonEnvReferences(source);
  }
  return [];
}

function extractJavaScriptEnvReferences(source: string): EnvReference[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["typescript", "jsx", "decorators-legacy", "classProperties", "importMeta"]
    });
  } catch {
    return extractJavaScriptEnvReferencesByRegex(source);
  }

  const lines = source.split(/\r?\n/);
  const references: EnvReference[] = [];
  traverse(ast.program, (node) => {
    if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") {
      return;
    }

    const envRoot = getEnvRoot(node);
    if (!envRoot) {
      return;
    }

    const key = getStaticPropertyName(node);
    const line = node.loc?.start.line ?? 1;
    references.push({
      key,
      dynamic: !key,
      line,
      evidence: lines[line - 1]?.trim() ?? ""
    });
  });

  return references;
}

function getEnvRoot(node: t.MemberExpression | t.OptionalMemberExpression): "process" | "import.meta" | undefined {
  const object = node.object;
  if (object.type === "MemberExpression" || object.type === "OptionalMemberExpression") {
    const property = getStaticPropertyName(object);
    if (property !== "env") {
      return undefined;
    }

    if (isProcessIdentifier(object.object)) {
      return "process";
    }
    if (isImportMeta(object.object)) {
      return "import.meta";
    }
  }
  return undefined;
}

function isProcessIdentifier(node: t.Node): boolean {
  return node.type === "Identifier" && node.name === "process";
}

function isImportMeta(node: t.Node): boolean {
  return node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta";
}

function getStaticPropertyName(node: t.MemberExpression | t.OptionalMemberExpression): string | undefined {
  const property = node.property;
  if (!node.computed && property.type === "Identifier") {
    return property.name;
  }
  if (property.type === "StringLiteral") {
    return property.value;
  }
  return undefined;
}

function extractJavaScriptEnvReferencesByRegex(source: string): EnvReference[] {
  const references: EnvReference[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const match of line.matchAll(/\b(?:process|import\.meta)\.env\.([A-Z_][A-Z0-9_]*)\b/g)) {
      references.push({
        key: match[1],
        dynamic: false,
        line: lineNumber,
        evidence: line.trim()
      });
    }
    if (/\b(?:process|import\.meta)\.env\[[^\]"']+\]/.test(line)) {
      references.push({
        dynamic: true,
        line: lineNumber,
        evidence: line.trim()
      });
    }
  });
  return references;
}

function extractPythonEnvReferences(source: string): EnvReference[] {
  const references: EnvReference[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const patterns = [
      /\bos\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
      /\bos\.environ\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*[,)]/g,
      /\bos\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*[,)]/g
    ];

    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        references.push({
          key: match[1],
          dynamic: false,
          line: lineNumber,
          evidence: line.trim()
        });
      }
    }

    if (/\bos\.environ\[[^\]"']+\]/.test(line) || /\bos\.getenv\([^"']/.test(line)) {
      references.push({
        dynamic: true,
        line: lineNumber,
        evidence: line.trim()
      });
    }
  });

  return references;
}

function traverse(node: t.Node, visitor: (node: t.Node) => void): void {
  visitor(node);

  const record = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }

    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          traverse(item, visitor);
        }
      }
      continue;
    }

    if (isNode(value)) {
      traverse(value, visitor);
    }
  }
}

function isNode(value: unknown): value is t.Node {
  return Boolean(value && typeof value === "object" && "type" in value);
}
