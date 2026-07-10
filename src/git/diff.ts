import { execFileSync } from "node:child_process";

export type DiffStatus = "added" | "modified" | "removed" | "renamed" | "unknown";

export interface DiffFile {
  filename: string;
  previousFilename?: string;
  status: DiffStatus;
  patch?: string;
  addedLines: Set<number>;
  removedLines: Set<number>;
  addedLineContent: Map<number, string>;
}

export interface GitHubDiffOptions {
  token: string;
  owner: string;
  repo: string;
  base: string;
  head: string;
}

export async function getGitHubDiff(options: GitHubDiffOptions): Promise<DiffFile[]> {
  const github = await import("@actions/github");
  const octokit = github.getOctokit(options.token);
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: options.owner,
    repo: options.repo,
    basehead: `${options.base}...${options.head}`
  });

  return (response.data.files ?? []).map((file) => {
    const parsed = parsePatch(file.filename, file.patch ?? "");
    return {
      ...parsed,
      status: normalizeStatus(file.status),
      previousFilename: file.previous_filename
    };
  });
}

export function getLocalGitDiff(rootDir: string, base = "HEAD~1", head = "HEAD"): DiffFile[] {
  const output = execFileSync("git", ["diff", "--unified=0", `${base}...${head}`], {
    cwd: rootDir,
    encoding: "utf8"
  });

  return parseUnifiedDiff(output);
}

export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diffText.split(/^diff --git /m).filter((chunk) => chunk.trim().length > 0);

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const header = lines[0] ?? "";
    const match = header.match(/^a\/(.+?) b\/(.+)$/);
    let filename = match?.[2] ?? "";
    let previousFilename = match?.[1];
    let status: DiffStatus = "modified";
    let patchStart = 0;

    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.startsWith("new file mode")) {
        status = "added";
      } else if (line.startsWith("deleted file mode")) {
        status = "removed";
      } else if (line.startsWith("rename from ")) {
        status = "renamed";
        previousFilename = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        filename = line.slice("rename to ".length);
      } else if (line.startsWith("+++ ")) {
        const nextPath = line.slice(4);
        if (nextPath !== "/dev/null") {
          filename = stripDiffPrefix(nextPath);
        }
      } else if (line.startsWith("@@")) {
        patchStart = index;
        break;
      }
    }

    const patch = patchStart > 0 ? lines.slice(patchStart).join("\n") : "";
    const parsed = parsePatch(filename, patch);
    files.push({
      ...parsed,
      status,
      previousFilename: previousFilename === filename ? undefined : previousFilename
    });
  }

  return files;
}

export function parsePatch(filename: string, patch: string): DiffFile {
  const addedLines = new Set<number>();
  const removedLines = new Set<number>();
  const addedLineContent = new Map<number, string>();
  const lines = patch.split(/\r?\n/);
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (line.startsWith("+++") || line.startsWith("---") || line.length === 0) {
      continue;
    }

    if (line.startsWith("+")) {
      addedLines.add(newLine);
      addedLineContent.set(newLine, line.slice(1));
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      removedLines.add(oldLine);
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return {
    filename,
    status: "modified",
    patch,
    addedLines,
    removedLines,
    addedLineContent
  };
}

export function getChangedFile(diff: DiffFile[], filename: string): DiffFile | undefined {
  return diff.find((file) => file.filename === filename);
}

function normalizeStatus(status: string | undefined): DiffStatus {
  if (status === "added" || status === "modified" || status === "removed" || status === "renamed") {
    return status;
  }
  return "unknown";
}

function stripDiffPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}
