import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export interface WorkflowEventTrigger {
  paths: string[];
  pathsIgnore: string[];
  branches: string[];
  branchesIgnore: string[];
}

export interface WorkflowTriggers {
  eventNames: string[];
  events: Record<string, WorkflowEventTrigger>;
}

export type CheckMappingKind = "job" | "matrix" | "reusable";
export type UnresolvedCheckMappingReason = "dynamic-name" | "external-reusable" | "local-reusable-missing";

export interface WorkflowCheckMapping {
  checkName: string;
  jobId: string;
  jobName?: string;
  kind: CheckMappingKind;
  file: string;
  line: number;
  matrix?: Record<string, string>;
  reusableWorkflow?: string;
}

export interface WorkflowUnresolvedCheckMapping {
  jobId: string;
  jobName?: string;
  reason: UnresolvedCheckMappingReason;
  file: string;
  line: number;
  uses?: string;
}

export interface WorkflowStep {
  jobId: string;
  jobName?: string;
  stepName?: string;
  uses?: string;
  run?: string;
  line: number;
  endLine: number;
  continueOnError?: boolean;
  continueOnErrorLine?: number;
}

export interface WorkflowJob {
  id: string;
  name?: string;
  if?: string;
  uses?: string;
  line: number;
  endLine: number;
  steps: WorkflowStep[];
  checkNames: string[];
  dynamicName: boolean;
  reusable: boolean;
}

export interface ParsedWorkflow {
  file: string;
  on: WorkflowTriggers;
  jobs: WorkflowJob[];
  steps: WorkflowStep[];
  checkMappings: WorkflowCheckMapping[];
  unresolvedCheckMappings: WorkflowUnresolvedCheckMapping[];
  parseErrors: string[];
}

export interface ParseWorkflowOptions {
  filePath?: string;
  workflowFiles?: Record<string, string>;
  seenFiles?: Set<string>;
}

type SourcePosition = [number, number, number];

const emptyTrigger: WorkflowEventTrigger = {
  paths: [],
  pathsIgnore: [],
  branches: [],
  branchesIgnore: []
};

export function parseWorkflow(source: string, options: ParseWorkflowOptions = {}): ParsedWorkflow {
  const lineOffsets = buildLineOffsets(source);
  const file = options.filePath ?? ".github/workflows/workflow.yml";
  const seenFiles = new Set(options.seenFiles ?? []);
  seenFiles.add(file);
  const parseErrors: string[] = [];
  const document = parseDocument(source, { keepSourceTokens: true });
  parseErrors.push(...document.errors.map((error) => error.message));

  const root = document.contents;
  const on = parseWorkflowTriggers(getMapValue(root, "on"));
  const jobsNode = getMapValue(root, "jobs");
  const jobs: WorkflowJob[] = [];
  const steps: WorkflowStep[] = [];
  const checkMappings: WorkflowCheckMapping[] = [];
  const unresolvedCheckMappings: WorkflowUnresolvedCheckMapping[] = [];

  for (const jobEntry of mapEntries(jobsNode)) {
    const jobId = jobEntry.key;
    const jobNode = jobEntry.value;
    const jobName = stringValue(getMapValue(jobNode, "name"));
    const jobIf = stringValue(getMapValue(jobNode, "if"));
    const uses = stringValue(getMapValue(jobNode, "uses"));
    const line = nodeStartLine(jobEntry.keyNode, lineOffsets) ?? nodeStartLine(jobNode, lineOffsets) ?? 1;
    const endLine = nodeEndLine(jobNode, lineOffsets) ?? line;
    const dynamicName = jobName ? isDynamicExpression(jobName) : false;
    const jobSteps = parseSteps(jobNode, jobId, jobName, lineOffsets);
    const job: WorkflowJob = {
      id: jobId,
      name: jobName,
      if: jobIf,
      uses,
      line,
      endLine,
      steps: jobSteps,
      checkNames: [],
      dynamicName,
      reusable: Boolean(uses)
    };

    const mappingResult = buildCheckMappings(job, jobNode, {
      file,
      workflowFiles: options.workflowFiles,
      seenFiles,
      lineOffsets
    });
    job.checkNames = mappingResult.mappings.map((mapping) => mapping.checkName);
    checkMappings.push(...mappingResult.mappings);
    unresolvedCheckMappings.push(...mappingResult.unresolved);

    jobs.push(job);
    steps.push(...jobSteps);
  }

  return {
    file,
    on,
    jobs,
    steps,
    checkMappings,
    unresolvedCheckMappings,
    parseErrors
  };
}

export function parseWorkflowFiles(files: Record<string, string>): ParsedWorkflow[] {
  return Object.entries(files)
    .filter(([file]) => isWorkflowFile(file))
    .map(([file, source]) =>
      parseWorkflow(source, {
        filePath: file,
        workflowFiles: files
      })
    );
}

export function isWorkflowFile(file: string): boolean {
  return /^\.github\/workflows\/.+\.ya?ml$/.test(normalizeWorkflowPath(file));
}

export function findJobForLine(workflow: ParsedWorkflow, line: number): WorkflowJob | undefined {
  return workflow.jobs.find((job) => line >= job.line && line <= job.endLine);
}

export function findStepForLine(workflow: ParsedWorkflow, line: number): WorkflowStep | undefined {
  return workflow.steps.find((step) => line >= step.line && line <= step.endLine);
}

function parseWorkflowTriggers(onNode: unknown): WorkflowTriggers {
  const events: Record<string, WorkflowEventTrigger> = {};

  if (isScalar(onNode)) {
    const eventName = scalarToString(onNode.value);
    if (eventName) {
      events[eventName] = { ...emptyTrigger };
    }
  } else if (isSeq(onNode)) {
    for (const item of onNode.items) {
      const eventName = stringValue(item);
      if (eventName) {
        events[eventName] = { ...emptyTrigger };
      }
    }
  } else if (isMap(onNode)) {
    for (const entry of mapEntries(onNode)) {
      events[entry.key] = parseWorkflowEvent(entry.value);
    }
  }

  return {
    eventNames: Object.keys(events),
    events
  };
}

function parseWorkflowEvent(node: unknown): WorkflowEventTrigger {
  if (!isMap(node)) {
    return { ...emptyTrigger };
  }

  return {
    paths: stringArrayValue(getMapValue(node, "paths")),
    pathsIgnore: stringArrayValue(getMapValue(node, "paths-ignore")),
    branches: stringArrayValue(getMapValue(node, "branches")),
    branchesIgnore: stringArrayValue(getMapValue(node, "branches-ignore"))
  };
}

function parseSteps(jobNode: unknown, jobId: string, jobName: string | undefined, lineOffsets: number[]): WorkflowStep[] {
  const stepsNode = getMapValue(jobNode, "steps");
  if (!isSeq(stepsNode)) {
    return [];
  }

  const steps: WorkflowStep[] = [];
  for (const item of stepsNode.items) {
    if (!isMap(item)) {
      continue;
    }

    const continueOnErrorEntry = findMapEntry(item, "continue-on-error");
    const step: WorkflowStep = {
      jobId,
      jobName,
      stepName: stringValue(getMapValue(item, "name")),
      uses: stringValue(getMapValue(item, "uses")),
      run: stringValue(getMapValue(item, "run")),
      line: nodeStartLine(item, lineOffsets) ?? 1,
      endLine: nodeEndLine(item, lineOffsets) ?? nodeStartLine(item, lineOffsets) ?? 1,
      continueOnError: booleanValue(continueOnErrorEntry?.value),
      continueOnErrorLine: continueOnErrorEntry ? nodeStartLine(continueOnErrorEntry.keyNode, lineOffsets) : undefined
    };
    steps.push(step);
  }

  return steps;
}

function buildCheckMappings(
  job: WorkflowJob,
  jobNode: unknown,
  context: {
    file: string;
    workflowFiles?: Record<string, string>;
    seenFiles: Set<string>;
    lineOffsets: number[];
  }
): {
  mappings: WorkflowCheckMapping[];
  unresolved: WorkflowUnresolvedCheckMapping[];
} {
  if (job.dynamicName) {
    return {
      mappings: [],
      unresolved: [
        {
          jobId: job.id,
          jobName: job.name,
          reason: "dynamic-name",
          file: context.file,
          line: job.line
        }
      ]
    };
  }

  const displayName = job.name ?? job.id;
  if (job.uses) {
    return buildReusableCheckMappings(job, displayName, context);
  }

  const matrix = expandMatrix(getMapValue(getMapValue(jobNode, "strategy"), "matrix"));
  if (matrix.length > 0) {
    return {
      mappings: matrix.map((combo) => ({
        checkName: `${displayName} (${Object.values(combo).join(", ")})`,
        jobId: job.id,
        jobName: job.name,
        kind: "matrix",
        file: context.file,
        line: job.line,
        matrix: combo
      })),
      unresolved: []
    };
  }

  return {
    mappings: [
      {
        checkName: displayName,
        jobId: job.id,
        jobName: job.name,
        kind: "job",
        file: context.file,
        line: job.line
      }
    ],
    unresolved: []
  };
}

function buildReusableCheckMappings(
  job: WorkflowJob,
  displayName: string,
  context: {
    file: string;
    workflowFiles?: Record<string, string>;
    seenFiles: Set<string>;
  }
): {
  mappings: WorkflowCheckMapping[];
  unresolved: WorkflowUnresolvedCheckMapping[];
} {
  const uses = job.uses ?? "";
  const localPath = normalizeLocalReusablePath(uses);
  if (!localPath) {
    return {
      mappings: [],
      unresolved: [
        {
          jobId: job.id,
          jobName: job.name,
          reason: "external-reusable",
          file: context.file,
          line: job.line,
          uses
        }
      ]
    };
  }

  const source = context.workflowFiles?.[localPath];
  if (source === undefined || context.seenFiles.has(localPath)) {
    return {
      mappings: [],
      unresolved: [
        {
          jobId: job.id,
          jobName: job.name,
          reason: "local-reusable-missing",
          file: context.file,
          line: job.line,
          uses
        }
      ]
    };
  }

  const inner = parseWorkflow(source, {
    filePath: localPath,
    workflowFiles: context.workflowFiles,
    seenFiles: context.seenFiles
  });

  return {
    mappings: inner.checkMappings.map((mapping) => ({
      ...mapping,
      checkName: `${displayName} / ${mapping.checkName}`,
      jobId: job.id,
      jobName: job.name,
      kind: "reusable",
      file: context.file,
      line: job.line,
      reusableWorkflow: localPath
    })),
    unresolved: inner.unresolvedCheckMappings.map((mapping) => ({
      ...mapping,
      jobId: job.id,
      jobName: job.name,
      file: context.file,
      line: job.line,
      uses
    }))
  };
}

function expandMatrix(matrixNode: unknown): Array<Record<string, string>> {
  if (!isMap(matrixNode)) {
    return [];
  }

  const axes: Array<{ key: string; values: string[] }> = [];
  const include: Array<Record<string, string>> = [];
  const exclude: Array<Record<string, string>> = [];

  for (const entry of mapEntries(matrixNode)) {
    if (entry.key === "include") {
      include.push(...objectArrayValue(entry.value));
      continue;
    }
    if (entry.key === "exclude") {
      exclude.push(...objectArrayValue(entry.value));
      continue;
    }
    const values = stringArrayValue(entry.value);
    if (values.length > 0) {
      axes.push({ key: entry.key, values });
    }
  }

  if (axes.length === 0 && include.length === 0) {
    return [];
  }

  let combinations = axes.reduce<Array<Record<string, string>>>(
    (acc, axis) =>
      acc.flatMap((combo) =>
        axis.values.map((value) => ({
          ...combo,
          [axis.key]: value
        }))
      ),
    [{}]
  );

  for (const includeEntry of include) {
    let applied = false;
    combinations = combinations.map((combo) => {
      if (canMergeMatrixInclude(combo, includeEntry)) {
        applied = true;
        return { ...combo, ...includeEntry };
      }
      return combo;
    });
    if (!applied) {
      combinations.push(includeEntry);
    }
  }

  return combinations.filter((combo) => !exclude.some((excludeEntry) => matrixEntryMatches(combo, excludeEntry)));
}

function canMergeMatrixInclude(combo: Record<string, string>, includeEntry: Record<string, string>): boolean {
  return Object.entries(includeEntry).every(([key, value]) => combo[key] === undefined || combo[key] === value);
}

function matrixEntryMatches(combo: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => combo[key] === value);
}

function objectArrayValue(node: unknown): Array<Record<string, string>> {
  if (!isSeq(node)) {
    return [];
  }
  return node.items.flatMap((item) => {
    if (!isMap(item)) {
      return [];
    }
    const record: Record<string, string> = {};
    for (const entry of mapEntries(item)) {
      const value = stringValue(entry.value);
      if (value !== undefined) {
        record[entry.key] = value;
      }
    }
    return Object.keys(record).length > 0 ? [record] : [];
  });
}

function stringArrayValue(node: unknown): string[] {
  if (isSeq(node)) {
    return node.items.map((item) => stringValue(item)).filter((value): value is string => value !== undefined);
  }
  const value = stringValue(node);
  return value === undefined ? [] : [value];
}

function getMapValue(map: unknown, key: string): unknown {
  return findMapEntry(map, key)?.value;
}

function findMapEntry(
  map: unknown,
  key: string
): { key: string; keyNode: unknown; value: unknown } | undefined {
  return mapEntries(map).find((entry) => entry.key === key);
}

function mapEntries(map: unknown): Array<{ key: string; keyNode: unknown; value: unknown }> {
  if (!isMap(map)) {
    return [];
  }

  return map.items.flatMap((pair) => {
    const key = stringValue(pair.key);
    if (key === undefined) {
      return [];
    }
    return [
      {
        key,
        keyNode: pair.key,
        value: pair.value
      }
    ];
  });
}

function stringValue(node: unknown): string | undefined {
  if (!isScalar(node)) {
    return undefined;
  }
  return scalarToString(node.value);
}

function scalarToString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}

function booleanValue(node: unknown): boolean | undefined {
  if (!isScalar(node)) {
    return undefined;
  }
  if (typeof node.value === "boolean") {
    return node.value;
  }
  if (typeof node.value === "string") {
    if (/^true$/i.test(node.value)) {
      return true;
    }
    if (/^false$/i.test(node.value)) {
      return false;
    }
  }
  return undefined;
}

function isDynamicExpression(value: string): boolean {
  return /\$\{\{[\s\S]*\}\}/.test(value);
}

function normalizeLocalReusablePath(uses: string): string | undefined {
  if (!uses.startsWith("./")) {
    return undefined;
  }
  return normalizeWorkflowPath(uses.slice(2));
}

function normalizeWorkflowPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\/+/, "");
}

function nodeStartLine(node: unknown, lineOffsets: number[]): number | undefined {
  const range = nodeRange(node);
  return range ? offsetToLine(range[0], lineOffsets) : undefined;
}

function nodeEndLine(node: unknown, lineOffsets: number[]): number | undefined {
  const range = nodeRange(node);
  return range ? offsetToLine(Math.max(range[2] - 1, range[0]), lineOffsets) : undefined;
}

function nodeRange(node: unknown): SourcePosition | undefined {
  const range = (node as { range?: unknown } | undefined)?.range;
  if (!Array.isArray(range) || range.length < 3) {
    return undefined;
  }
  const [start, valueEnd, end] = range;
  return typeof start === "number" && typeof valueEnd === "number" && typeof end === "number"
    ? [start, valueEnd, end]
    : undefined;
}

function buildLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetToLine(offset: number, lineOffsets: number[]): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineOffsets[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return high + 1;
}
