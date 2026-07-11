#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify as cryptoVerify } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { canonicalJson } = loadBuildModule("../build/core/canonicalJson.js");
const { verifyLicense } = loadBuildModule("../build/license/verify.js");

const COMPLIANCE_HEADLINE =
  "SELF-ATTESTED evidence input for INTERNAL governance visibility. This is NOT an independent audit attestation / audit evidence.";
const COMPLIANCE_NOTE =
  "This report is self-attested evidence of detected attempts to weaken CI gates across the organization, produced by the org itself. It is NOT an independent audit attestation and NOT audit evidence. Record content integrity is honor-system: a record's org-proof marker proves the producing org held a valid license, but does NOT bind the record body, so an org with a valid license could alter its own records before aggregation (same class of structural limit as owner.type honor-system). Use it for internal governance visibility; an auditor treats it as an evidence input to be independently re-verified. See README.";
const MAPPING_HINT =
  "SOC2 CC8.1 / ISO 27001 A.12.1.2 change-management EVIDENCE INPUT only - this is not proof of control implementation and does not replace an auditor's assessment.";
const INTEGRITY_NOTE =
  "Signed by the org's evidence-collection repo batch runner (which has no issuer private key). Detects tampering of this report file AND its source record set AFTER issuance (via sourceRecordHashes recompute). It is NOT an issuer authenticity guarantee and NOT the basis of audit trust (see README).";

export async function aggregateFromInputs(inputs, options = {}) {
  const sourceRecords = await loadEvidenceRecordsFromInputs(inputs);
  return aggregateEvidenceRecords(sourceRecords, options);
}

export async function loadEvidenceRecordsFromInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("At least one --input file or directory is required.");
  }

  const files = [];
  for (const input of inputs) {
    const absolute = resolve(String(input));
    const inputStat = await stat(absolute);
    if (inputStat.isDirectory()) {
      files.push(...(await listJsonFiles(absolute)));
    } else if (inputStat.isFile() && extname(absolute) === ".json") {
      files.push(absolute);
    }
  }

  files.sort();
  const records = [];
  for (const file of files) {
    const raw = await readFile(file);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new Error(`Unable to parse Evidence Record JSON at ${file}: ${error.message}`);
    }
    records.push({ path: file, raw, record: parsed });
  }
  return records;
}

export function aggregateEvidenceRecords(sourceRecords, options = {}) {
  const normalized = normalizeSourceRecords(sourceRecords);
  const selection = selectIncludedRecords(normalized, options);
  const now = parseDateOption(options.generatedAt ?? options.now ?? new Date());
  const generatedAt = now.toISOString();
  const period = determinePeriod(selection.included, options, now);
  const reportSigningKey = options.reportSigningKey ?? process.env.FCP_REPORT_SIGNING_KEY;

  if (!reportSigningKey || (typeof reportSigningKey === "string" && !reportSigningKey.trim())) {
    throw new Error("FCP_REPORT_SIGNING_KEY is required to sign the Organization Evidence Report.");
  }

  const reportWithoutSignature = buildReport({
    generatedAt,
    period,
    selection,
    reportSigningKeyId:
      options.reportSigningKeyId ?? process.env.FCP_REPORT_SIGNING_KEY_ID ?? "org-evidence-collection-repo-key"
  });
  const reportSignature = signReport(reportWithoutSignature, reportSigningKey);
  const report = {
    ...reportWithoutSignature,
    integrity: {
      ...reportWithoutSignature.integrity,
      reportSignature
    }
  };

  return {
    report,
    markdown: renderMarkdown(report),
    warnings: selection.warnings,
    includedRecords: selection.included.map((item) => item.record),
    excludedRecords: selection.excluded.map((item) => item.record),
    excludedByRepoCapRepos: selection.excludedByRepoCapRepos
  };
}

export function calculateIncludedSourceRecordHashes(sourceRecords, options = {}) {
  const selection = selectIncludedRecords(normalizeSourceRecords(sourceRecords), options);
  return selection.sourceRecordHashes;
}

export function findSourceRecordHashMismatches(report, sourceRecords, options = {}) {
  const expected = [...(report?.provenance?.sourceRecordHashes ?? [])].sort();
  const actual = calculateIncludedSourceRecordHashes(sourceRecords, options).sort();
  return {
    valid: arraysEqual(expected, actual),
    missing: expected.filter((hash) => !actual.includes(hash)),
    added: actual.filter((hash) => !expected.includes(hash))
  };
}

export function renderMarkdown(report) {
  const byKindRows = Object.entries(report.summary.byKind)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `| ${escapeMarkdown(kind)} | ${count} |`)
    .join("\n");
  const timeRows = report.timeSeries
    .map((row) => `| ${row.week} | ${row.attempts} | ${row.weakenings} |`)
    .join("\n");
  const actorRows = report.repeatActors
    .map(
      (row) =>
        `| ${escapeMarkdown(row.actor)} | ${row.attemptCount} | ${escapeMarkdown(row.repos.join(", "))} | ${row.firstSeen} | ${row.lastSeen} |`
    )
    .join("\n");
  const repoRows = report.repeatRepos
    .map((row) => `| ${escapeMarkdown(row.repo)} | ${row.attemptCount} | ${row.distinctActors} |`)
    .join("\n");

  return `# Organization Evidence Report - ${report.org}

> ${report.compliance.headline}

Generated: ${report.generatedAt}
Period: ${report.period.from} to ${report.period.to}
Repos covered: ${report.reposCovered.length}
Included records: ${report.recordCount}
Excluded invalid or unlicensed records: ${report.excludedRecordCount}
Excluded repos over license cap: ${report.excludedByRepoCap}

## Summary

| Metric | Value |
| --- | ---: |
| Total attempts | ${report.summary.totalAttempts} |
| Total weakenings | ${report.summary.totalWeakenings} |
| Repos with attempts | ${report.summary.reposWithAttempts} |

## By Kind

| Kind | Count |
| --- | ---: |
${byKindRows || "| None | 0 |"}

## Weekly Trend

| Week | Attempts | Weakenings |
| --- | ---: | ---: |
${timeRows || "| None | 0 | 0 |"}

## Repeat Actors

| Actor | Attempts | Repos | First seen | Last seen |
| --- | ---: | --- | --- | --- |
${actorRows || "| None | 0 |  |  |  |"}

## Repeat Repos

| Repo | Attempts | Distinct actors |
| --- | ---: | ---: |
${repoRows || "| None | 0 | 0 |"}

## Compliance Positioning

${report.compliance.note}

${report.compliance.mappingHint}

## Integrity

${report.integrity.note}

- Signed by: ${report.integrity.signedBy}
- Signing key: ${report.integrity.keyId}
- Source record hashes: ${report.provenance.sourceRecordHashes.length}
`;
}

export function verifyReportSignature(report, publicKeyInput) {
  if (!report?.integrity?.reportSignature) {
    return false;
  }
  try {
    const publicKey = parsePublicKey(publicKeyInput);
    return cryptoVerify(
      null,
      Buffer.from(reportSigningPayload(report), "utf8"),
      publicKey,
      Buffer.from(report.integrity.reportSignature, "base64")
    );
  } catch {
    return false;
  }
}

export function reportSigningPayload(report) {
  const unsigned = JSON.parse(JSON.stringify(report));
  unsigned.integrity.reportSignature = "";
  return canonicalJson(unsigned);
}

function selectIncludedRecords(sourceRecords, options) {
  const licenseText = options.licenseText ?? process.env.FCP_LICENSE;
  if (!licenseText || !String(licenseText).trim()) {
    throw new Error("FCP_LICENSE is required to aggregate Organization Evidence Reports.");
  }

  const decodedOrg = decodeLicenseOrg(licenseText);
  const org = options.org ?? decodedOrg;
  if (!org) {
    throw new Error("FCP_LICENSE is malformed: unable to read payload.org.");
  }

  const now = parseDateOption(options.now ?? new Date());
  const licenseVerification = verifyLicense(licenseText, {
    org,
    now,
    publicKeys: options.publicKeys
  });
  if (!licenseVerification.valid) {
    throw new Error(
      `Organization Evidence Report aggregation requires a valid FCP_LICENSE: ${licenseVerification.reason} - ${licenseVerification.message}`
    );
  }

  const warnings = [];
  const candidates = [];
  const excluded = [];

  for (const source of sourceRecords) {
    const reason = markerExclusionReason(source.record, licenseVerification, options);
    if (reason) {
      excluded.push(source);
      warnings.push(warn(`Excluded ${recordLabel(source.record, source.path)}: ${reason}.`, options));
      continue;
    }
    candidates.push(source);
  }

  const repos = [...new Set(candidates.map((item) => item.record.repo))].sort();
  const maxRepos = licenseVerification.payload.maxRepos;
  const allowedRepos = new Set(repos.slice(0, maxRepos));
  const excludedByRepoCapRepos = repos.slice(maxRepos);
  for (const repo of excludedByRepoCapRepos) {
    warnings.push(warn(`Excluded repo ${repo}: license maxRepos=${maxRepos} allows only the first ${maxRepos} repos by lexical order.`, options));
  }

  const included = candidates.filter((item) => allowedRepos.has(item.record.repo));
  const capExcluded = candidates.filter((item) => !allowedRepos.has(item.record.repo));

  const sortedIncluded = included.sort(compareIncludedRecords);
  return {
    org: licenseVerification.payload.org,
    licensePayload: licenseVerification.payload,
    warnings,
    included: sortedIncluded,
    excluded: [...excluded, ...capExcluded],
    excludedRecordCount: excluded.length,
    excludedByRepoCap: excludedByRepoCapRepos.length,
    excludedByRepoCapRepos,
    sourceRecordHashes: sortedIncluded.map((item) => item.hash).sort()
  };
}

function markerExclusionReason(record, licenseVerification, options) {
  if (!record || typeof record !== "object") {
    return "malformed record";
  }
  if (!record.repo || typeof record.repo !== "string" || !record.repo.includes("/")) {
    return "missing or malformed repo";
  }

  const repoOwner = record.repo.split("/")[0];
  if (!sameGitHubOwner(licenseVerification.payload.org, repoOwner)) {
    return `license org '${licenseVerification.payload.org}' does not match repo owner '${repoOwner}'`;
  }

  const license = record.license;
  const markerPresent = license?.signaturePresent === true;
  if (license?.org !== true || !markerPresent || !record.signature) {
    return "missing valid license marker";
  }
  if (license.licenseId !== licenseVerification.payload.licenseId) {
    return "record licenseId does not match the verified organization license";
  }

  const signature = record.signature;
  if (signature.alg !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") {
    return "malformed license marker";
  }
  if (signature.keyId !== licenseVerification.payload.keyId) {
    return `marker keyId '${signature.keyId}' does not match verified license keyId '${licenseVerification.payload.keyId}'`;
  }
  if (signature.markerType !== undefined && signature.markerType !== "license-holder-org-proof") {
    return "markerType is not license-holder-org-proof";
  }
  if (signature.signedTarget !== undefined && signature.signedTarget !== "issuer-license-payload") {
    return "signedTarget is not issuer-license-payload";
  }

  const markerLicenseText = encodeLicenseEnvelope({
    payload: licenseVerification.payload,
    signature: signature.value
  });
  const markerVerification = verifyLicense(markerLicenseText, {
    org: licenseVerification.payload.org,
    now: parseDateOption(options.now ?? new Date()),
    publicKeys: options.publicKeys
  });
  if (!markerVerification.valid) {
    return `issuer-license marker signature failed verification (${markerVerification.reason})`;
  }
  if (signature.value !== licenseVerification.signature) {
    return "marker signature is not the verified organization license signature";
  }

  return undefined;
}

function buildReport({ generatedAt, period, selection, reportSigningKeyId }) {
  const summary = summarize(selection.included);
  return {
    schemaVersion: "1.0",
    org: selection.org,
    generatedAt,
    period,
    reposCovered: [...new Set(selection.included.map((item) => item.record.repo))].sort(),
    recordCount: selection.included.length,
    excludedRecordCount: selection.excludedRecordCount,
    excludedByRepoCap: selection.excludedByRepoCap,
    summary,
    timeSeries: buildTimeSeries(selection.included),
    repeatActors: buildRepeatActors(selection.included),
    repeatRepos: buildRepeatRepos(selection.included),
    compliance: {
      headline: COMPLIANCE_HEADLINE,
      note: COMPLIANCE_NOTE,
      mappingHint: MAPPING_HINT
    },
    integrity: {
      alg: "ed25519",
      keyId: reportSigningKeyId,
      reportSignature: "",
      signedBy: "org-evidence-collection-repo-batch",
      note: INTEGRITY_NOTE
    },
    provenance: {
      issuer: "false-clean-pass evidence pipeline",
      aggregationScope: "static-batch",
      sourceRecordHashes: selection.sourceRecordHashes
    }
  };
}

function summarize(included) {
  const byKind = new Map();
  let totalAttempts = 0;
  let totalWeakenings = 0;
  const reposWithAttempts = new Set();

  for (const { record } of included) {
    const attempts = Array.isArray(record.attempts) ? record.attempts : [];
    const weakenings = Array.isArray(record.weakenings) ? record.weakenings : [];
    totalAttempts += attempts.length;
    totalWeakenings += weakenings.length;
    if (attempts.length > 0) {
      reposWithAttempts.add(record.repo);
    }
    for (const item of [...attempts, ...weakenings]) {
      if (typeof item.kind === "string") {
        byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
      }
    }
  }

  return {
    totalAttempts,
    totalWeakenings,
    reposWithAttempts: reposWithAttempts.size,
    byKind: Object.fromEntries([...byKind.entries()].sort(([left], [right]) => left.localeCompare(right)))
  };
}

function buildTimeSeries(included) {
  const buckets = new Map();
  for (const { record } of included) {
    const week = isoWeek(record.timestamp);
    const current = buckets.get(week) ?? { week, attempts: 0, weakenings: 0 };
    current.attempts += Array.isArray(record.attempts) ? record.attempts.length : 0;
    current.weakenings += Array.isArray(record.weakenings) ? record.weakenings.length : 0;
    buckets.set(week, current);
  }
  return [...buckets.values()].sort((left, right) => left.week.localeCompare(right.week));
}

function buildRepeatActors(included) {
  const actors = new Map();
  for (const { record } of included) {
    const attemptCount = Array.isArray(record.attempts) ? record.attempts.length : 0;
    if (attemptCount === 0) {
      continue;
    }
    const actor = record.actor || "unknown";
    const item = actors.get(actor) ?? {
      actor,
      attemptCount: 0,
      repos: new Set(),
      firstSeen: dateOnly(record.timestamp),
      lastSeen: dateOnly(record.timestamp)
    };
    item.attemptCount += attemptCount;
    item.repos.add(record.repo);
    item.firstSeen = minDateOnly(item.firstSeen, dateOnly(record.timestamp));
    item.lastSeen = maxDateOnly(item.lastSeen, dateOnly(record.timestamp));
    actors.set(actor, item);
  }
  return [...actors.values()]
    .filter((item) => item.attemptCount > 1)
    .map((item) => ({
      actor: item.actor,
      attemptCount: item.attemptCount,
      repos: [...item.repos].sort(),
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen
    }))
    .sort((left, right) => right.attemptCount - left.attemptCount || left.actor.localeCompare(right.actor));
}

function buildRepeatRepos(included) {
  const repos = new Map();
  for (const { record } of included) {
    const attemptCount = Array.isArray(record.attempts) ? record.attempts.length : 0;
    if (attemptCount === 0) {
      continue;
    }
    const item = repos.get(record.repo) ?? {
      repo: record.repo,
      attemptCount: 0,
      actors: new Set()
    };
    item.attemptCount += attemptCount;
    item.actors.add(record.actor || "unknown");
    repos.set(record.repo, item);
  }
  return [...repos.values()]
    .filter((item) => item.attemptCount > 1)
    .map((item) => ({
      repo: item.repo,
      attemptCount: item.attemptCount,
      distinctActors: item.actors.size
    }))
    .sort((left, right) => right.attemptCount - left.attemptCount || left.repo.localeCompare(right.repo));
}

function determinePeriod(included, options, now) {
  if (options.periodFrom || options.periodTo) {
    return {
      from: options.periodFrom ?? dateOnly(minTimestamp(included) ?? now.toISOString()),
      to: options.periodTo ?? dateOnly(maxTimestamp(included) ?? now.toISOString())
    };
  }
  return {
    from: dateOnly(minTimestamp(included) ?? now.toISOString()),
    to: dateOnly(maxTimestamp(included) ?? now.toISOString())
  };
}

function minTimestamp(included) {
  return included.map((item) => item.record.timestamp).filter(Boolean).sort()[0];
}

function maxTimestamp(included) {
  const timestamps = included.map((item) => item.record.timestamp).filter(Boolean).sort();
  return timestamps[timestamps.length - 1];
}

function signReport(report, privateKeyInput) {
  const privateKey = parsePrivateKey(privateKeyInput);
  return sign(null, Buffer.from(reportSigningPayload(report), "utf8"), privateKey).toString("base64");
}

function normalizeSourceRecords(sourceRecords) {
  if (!Array.isArray(sourceRecords)) {
    throw new Error("sourceRecords must be an array.");
  }
  return sourceRecords
    .map((source, index) => {
      const record = source?.record ?? source;
      const raw =
        source?.raw instanceof Buffer
          ? source.raw
          : typeof source?.raw === "string"
            ? Buffer.from(source.raw, "utf8")
            : Buffer.from(canonicalJson(record), "utf8");
      return {
        path: source?.path ? String(source.path) : undefined,
        raw,
        hash: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        record,
        index
      };
    })
    .sort(compareSourceRecords);
}

function compareSourceRecords(left, right) {
  const leftKey = left.path ?? `${left.record?.repo ?? ""}|${left.record?.timestamp ?? ""}|${left.index}`;
  const rightKey = right.path ?? `${right.record?.repo ?? ""}|${right.record?.timestamp ?? ""}|${right.index}`;
  return leftKey.localeCompare(rightKey);
}

function compareIncludedRecords(left, right) {
  return (
    String(left.record.timestamp ?? "").localeCompare(String(right.record.timestamp ?? "")) ||
    String(left.record.repo ?? "").localeCompare(String(right.record.repo ?? "")) ||
    Number(left.record.prNumber ?? 0) - Number(right.record.prNumber ?? 0) ||
    String(left.record.headSha ?? "").localeCompare(String(right.record.headSha ?? ""))
  );
}

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(absolute)));
    } else if (entry.isFile() && extname(entry.name) === ".json") {
      files.push(absolute);
    }
  }
  return files;
}

function isoWeek(timestamp) {
  const date = validDate(timestamp);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dateOnly(timestamp) {
  return validDate(timestamp).toISOString().slice(0, 10);
}

function minDateOnly(left, right) {
  return left <= right ? left : right;
}

function maxDateOnly(left, right) {
  return left >= right ? left : right;
}

function validDate(value) {
  const date = new Date(value);
  if (Number.isFinite(date.getTime())) {
    return date;
  }
  return new Date(0);
}

function parseDateOption(value) {
  if (value instanceof Date) {
    return value;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function parsePrivateKey(value) {
  if (value && typeof value === "object" && value.type === "private") {
    return value;
  }
  const text = String(value).trim();
  if (text.includes("BEGIN PRIVATE KEY")) {
    return createPrivateKey(text);
  }
  return createPrivateKey({
    key: Buffer.from(text, "base64"),
    format: "der",
    type: "pkcs8"
  });
}

function parsePublicKey(value) {
  if (value && typeof value === "object" && value.type === "public") {
    return value;
  }
  const text = String(value).trim();
  if (text.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(text);
  }
  return createPublicKey({
    key: Buffer.from(text, "base64"),
    format: "der",
    type: "spki"
  });
}

function decodeLicenseOrg(licenseText) {
  try {
    const parsed = JSON.parse(Buffer.from(String(licenseText).trim(), "base64").toString("utf8"));
    return typeof parsed?.payload?.org === "string" ? parsed.payload.org : undefined;
  } catch {
    return undefined;
  }
}

function encodeLicenseEnvelope(envelope) {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function sameGitHubOwner(left, right) {
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

function recordLabel(record, path) {
  return path ?? `${record?.repo ?? "unknown-repo"}#${record?.prNumber ?? "unknown-pr"}@${record?.headSha ?? "unknown-sha"}`;
}

function warn(message, options) {
  if (options.logger?.warn) {
    options.logger.warn(message);
  } else if (options.quiet !== true && process.env.NODE_ENV !== "test") {
    process.stderr.write(`warning: ${message}\n`);
  }
  return message;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function loadBuildModule(path) {
  try {
    return require(path);
  } catch (error) {
    throw new Error(`Unable to load ${path}. Run npm run build before using tools/aggregate-report.mjs. ${error.message}`);
  }
}

function parseArgs(argv) {
  const args = {
    inputs: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if ((arg === "--input" || arg === "-i") && value) {
      args.inputs.push(value);
      index += 1;
    } else if ((arg === "--output" || arg === "--out" || arg === "-o") && value) {
      args.output = value;
      index += 1;
    } else if (arg === "--markdown" && value) {
      args.markdown = value;
      index += 1;
    } else if (arg === "--org" && value) {
      args.org = value;
      index += 1;
    } else if (arg === "--period-from" && value) {
      args.periodFrom = value;
      index += 1;
    } else if (arg === "--period-to" && value) {
      args.periodTo = value;
      index += 1;
    } else if (arg === "--generated-at" && value) {
      args.generatedAt = value;
      index += 1;
    } else if (arg === "--now" && value) {
      args.now = value;
      index += 1;
    } else if (arg === "--report-key-id" && value) {
      args.reportSigningKeyId = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  process.stdout.write(`Usage:
  FCP_LICENSE=<license> FCP_REPORT_SIGNING_KEY=<pem-or-base64-pkcs8-der> \\
    node tools/aggregate-report.mjs \\
      --input evidence-records \\
      --output reports/org-evidence-report.json \\
      --markdown reports/org-evidence-report.md

Inputs may be Evidence Record JSON files or directories containing committed records.
The report signature is made by the org evidence-collection repo batch key, not by an issuer key.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const output = args.output ?? "org-evidence-report.json";
  const markdown = args.markdown ?? output.replace(/\.json$/i, ".md");
  const result = await aggregateFromInputs(args.inputs, {
    org: args.org,
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    generatedAt: args.generatedAt,
    now: args.now,
    reportSigningKeyId: args.reportSigningKeyId
  });

  await mkdir(dirname(resolve(output)), { recursive: true });
  await mkdir(dirname(resolve(markdown)), { recursive: true });
  await writeFile(output, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  await writeFile(markdown, result.markdown, "utf8");
  process.stdout.write(`Wrote ${output} and ${markdown}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
