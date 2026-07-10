import { matchesAnyGlob } from "../core/globs";

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
  line: number;
}

export function parseCodeowners(source: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    const stripped = stripInlineComment(line).trim();
    if (!stripped) {
      return;
    }

    const [pattern, ...owners] = stripped.split(/\s+/);
    if (!pattern || owners.length === 0) {
      return;
    }

    entries.push({
      pattern,
      owners: owners.filter((owner) => owner.startsWith("@")),
      line: index + 1
    });
  });

  return entries;
}

export function findCodeOwnersForFile(source: string, file: string): string[] {
  let owners: string[] = [];
  for (const entry of parseCodeowners(source)) {
    if (matchesCodeownersPattern(entry.pattern, file)) {
      owners = entry.owners;
    }
  }
  return owners;
}

function matchesCodeownersPattern(pattern: string, file: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    return false;
  }

  if (normalized.endsWith("/")) {
    return file.startsWith(normalized);
  }

  if (normalized.includes("/")) {
    return matchesAnyGlob(file, [normalized]);
  }

  return matchesAnyGlob(file, [normalized, `**/${normalized}`]);
}

function stripInlineComment(line: string): string {
  const commentIndex = line.search(/\s#/);
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}
