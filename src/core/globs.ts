export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const normalized = normalizePath(file);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

export function isJavaScriptLikeFile(file: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(file);
}

export function isPythonFile(file: string): boolean {
  return /\.py$/.test(file);
}

export function isConfiguredTestFile(file: string, globs: string[]): boolean {
  return matchesAnyGlob(file, globs);
}

export function isTestFile(file: string, globs: string[]): boolean {
  return isJavaScriptLikeFile(file) && matchesAnyGlob(file, globs);
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      const closeIndex = normalized.indexOf("}", index);
      if (closeIndex > index) {
        const choices = normalized
          .slice(index + 1, closeIndex)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        source += `(?:${choices})`;
        index = closeIndex;
        continue;
      }
    }

    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source);
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
