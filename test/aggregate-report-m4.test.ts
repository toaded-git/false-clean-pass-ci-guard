import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/core/canonicalJson";
import { encodeLicenseEnvelope, type LicensePayload } from "../src/license/verify";
import { makeVerifyTempDir, repoRoot } from "./helpers";

interface IssuedLicense {
  text: string;
  payload: LicensePayload;
  signature: string;
}

let aggregate: any;

beforeAll(async () => {
  aggregate = await import("../tools/aggregate-report.mjs");
});

describe("M4 Organization Evidence Report aggregation", () => {
  it("aggregates 20 fixture records into summary, weekly trends, repeat actors, repeat repos, and schema-valid JSON", async () => {
    const issuer = createIssuer("k1");
    const reportSigner = createReportSigner();
    const license = issueLicense(licensePayload({ maxRepos: 10 }), issuer.privateKey);
    const records = twentyFixtureRecords(license);
    const root = makeVerifyTempDir("aggregate-m4-");
    const committedDir = writeRecords(join(root, "evidence-records"), records, "committed");

    const sourceRecords = await aggregate.loadEvidenceRecordsFromInputs([committedDir]);
    const result = aggregate.aggregateEvidenceRecords(sourceRecords, aggregateOptions(license, issuer, reportSigner));

    expect(result.report).toMatchObject({
      schemaVersion: "1.0",
      org: "acme",
      period: { from: "2026-01-05", to: "2026-01-21" },
      reposCovered: ["acme/api", "acme/infra", "acme/web"],
      recordCount: 20,
      excludedRecordCount: 0,
      excludedByRepoCap: 0
    });
    expect(result.report.summary).toEqual({
      totalAttempts: 20,
      totalWeakenings: 16,
      reposWithAttempts: 3,
      byKind: {
        baseline_change: 1,
        coverage_drop: 1,
        empty_assertion: 1,
        env_missing: 1,
        guard_weakening: 1,
        ignored_failure: 2,
        other: 1,
        parse_failure: 1,
        required_config_narrowed: 4,
        required_job_if_added_review: 2,
        required_job_if_skip_risk: 7,
        required_job_missing: 4,
        required_workflow_trigger_narrowed: 3,
        run_count_drop: 3,
        suppression_increase: 3,
        test_skip: 1
      }
    });
    expect(result.report.timeSeries).toEqual([
      { week: "2026-W02", attempts: 7, weakenings: 5 },
      { week: "2026-W03", attempts: 6, weakenings: 5 },
      { week: "2026-W04", attempts: 7, weakenings: 6 }
    ]);
    expect(result.report.repeatActors).toEqual([
      { actor: "alice", attemptCount: 7, repos: ["acme/api", "acme/infra", "acme/web"], firstSeen: "2026-01-05", lastSeen: "2026-01-20" },
      { actor: "bob", attemptCount: 5, repos: ["acme/api", "acme/infra", "acme/web"], firstSeen: "2026-01-06", lastSeen: "2026-01-21" },
      { actor: "erin", attemptCount: 4, repos: ["acme/api", "acme/infra", "acme/web"], firstSeen: "2026-01-08", lastSeen: "2026-01-19" },
      { actor: "carol", attemptCount: 3, repos: ["acme/api", "acme/web"], firstSeen: "2026-01-10", lastSeen: "2026-01-14" }
    ]);
    expect(result.report.repeatRepos).toEqual([
      { repo: "acme/web", attemptCount: 8, distinctActors: 4 },
      { repo: "acme/api", attemptCount: 7, distinctActors: 4 },
      { repo: "acme/infra", attemptCount: 5, distinctActors: 4 }
    ]);
    expect(result.report.compliance.headline).toContain("SELF-ATTESTED");
    expect(result.report.compliance.headline).toContain("NOT an independent audit attestation");
    expect(result.report.integrity).toMatchObject({
      alg: "ed25519",
      signedBy: "org-evidence-collection-repo-batch"
    });
    expect(result.report.integrity.note).toContain("NOT an issuer authenticity guarantee");
    expect(result.report.provenance.sourceRecordHashes).toHaveLength(20);
    expect(result.markdown).toContain("SELF-ATTESTED evidence input");
    expect(result.markdown).toContain("## Weekly Trend");
    expect(aggregate.verifyReportSignature(result.report, reportSigner.publicKeyBase64)).toBe(true);

    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/org-evidence-report.schema.json"), "utf8")) as object;
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    expect(validate(result.report), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("rejects aggregation without a valid organization license", () => {
    const reportSigner = createReportSigner();
    expect(() =>
      aggregate.aggregateEvidenceRecords([recordSource(evidenceRecord({ repo: "acme/api", license: null }))], {
        reportSigningKey: reportSigner.privateKeyBase64,
        quiet: true
      })
    ).toThrow(/FCP_LICENSE/);
  });

  it("excludes unlicensed and invalid-marker records instead of trusting signature field presence", () => {
    const issuer = createIssuer("k1");
    const otherIssuer = createIssuer("k2");
    const reportSigner = createReportSigner();
    const license = issueLicense(licensePayload({ maxRepos: 10 }), issuer.privateKey);
    const wrongOrgLicense = issueLicense(licensePayload({ licenseId: "lic_other", keyId: "k2", org: "other" }), otherIssuer.privateKey);
    const expiredLicense = issueLicense(
      licensePayload({ licenseId: "lic_expired", expiresAt: "2026-01-01T00:00:00.000Z" }),
      issuer.privateKey
    );
    const valid = evidenceRecord({ repo: "acme/api", prNumber: 1, headSha: "valid", license });
    const noMarker = evidenceRecord({ repo: "acme/api", prNumber: 2, headSha: "nomarker", license: null });
    const unknownKey = {
      ...evidenceRecord({ repo: "acme/api", prNumber: 3, headSha: "unknown", license }),
      signature: {
        ...markerFor(license),
        keyId: "k9"
      }
    };
    const wrongOrg = evidenceRecord({ repo: "acme/api", prNumber: 4, headSha: "wrongorg", license: wrongOrgLicense });
    const expired = evidenceRecord({ repo: "acme/api", prNumber: 5, headSha: "expired", license: expiredLicense });

    const result = aggregate.aggregateEvidenceRecords(
      [valid, noMarker, unknownKey, wrongOrg, expired].map(recordSource),
      aggregateOptions(license, issuer, reportSigner)
    );

    expect(result.report.recordCount).toBe(1);
    expect(result.report.excludedRecordCount).toBe(4);
    expect(result.report.summary.totalAttempts).toBe(1);
    expect(result.warnings.join("\n")).toContain("missing valid license marker");
    expect(result.warnings.join("\n")).toContain("keyId");
    expect(result.warnings.join("\n")).toContain("licenseId");
  });

  it("enforces maxRepos deterministically at aggregation time", () => {
    const issuer = createIssuer("k1");
    const reportSigner = createReportSigner();
    const cappedLicense = issueLicense(licensePayload({ maxRepos: 2 }), issuer.privateKey);
    const records = [
      evidenceRecord({ repo: "acme/c", prNumber: 1, headSha: "c", license: cappedLicense }),
      evidenceRecord({ repo: "acme/a", prNumber: 2, headSha: "a", license: cappedLicense }),
      evidenceRecord({ repo: "acme/b", prNumber: 3, headSha: "b", license: cappedLicense })
    ];

    const first = aggregate.aggregateEvidenceRecords(records.map(recordSource), aggregateOptions(cappedLicense, issuer, reportSigner));
    const second = aggregate.aggregateEvidenceRecords(
      [...records].reverse().map(recordSource),
      aggregateOptions(cappedLicense, issuer, reportSigner)
    );

    expect(first.report.reposCovered).toEqual(["acme/a", "acme/b"]);
    expect(first.report.recordCount).toBe(2);
    expect(first.report.excludedByRepoCap).toBe(1);
    expect(first.excludedByRepoCapRepos).toEqual(["acme/c"]);
    expect(second.report.reposCovered).toEqual(first.report.reposCovered);
    expect(second.excludedByRepoCapRepos).toEqual(first.excludedByRepoCapRepos);

    const uncappedLicense = issueLicense(licensePayload({ licenseId: "lic_uncapped", maxRepos: 3 }), issuer.privateKey);
    const uncappedRecords = records.map((record) => evidenceRecord({ repo: record.repo, prNumber: record.prNumber, headSha: record.headSha, license: uncappedLicense }));
    const uncapped = aggregate.aggregateEvidenceRecords(uncappedRecords.map(recordSource), aggregateOptions(uncappedLicense, issuer, reportSigner));
    expect(uncapped.report.reposCovered).toEqual(["acme/a", "acme/b", "acme/c"]);
    expect(uncapped.report.excludedByRepoCap).toBe(0);
  });

  it("detects post-aggregation source record tampering and report signature tampering", async () => {
    const issuer = createIssuer("k1");
    const reportSigner = createReportSigner();
    const license = issueLicense(licensePayload({ maxRepos: 10 }), issuer.privateKey);
    const records = [
      evidenceRecord({ repo: "acme/api", prNumber: 1, headSha: "aaa", license }),
      evidenceRecord({ repo: "acme/web", prNumber: 2, headSha: "bbb", license })
    ];
    const root = makeVerifyTempDir("aggregate-tamper-");
    const committedDir = writeRecords(join(root, "evidence-records"), records, "committed");
    const sourceRecords = await aggregate.loadEvidenceRecordsFromInputs([committedDir]);
    const result = aggregate.aggregateEvidenceRecords(sourceRecords, aggregateOptions(license, issuer, reportSigner));

    expect(aggregate.verifyReportSignature(result.report, reportSigner.publicKeyBase64)).toBe(true);
    const tamperedReport = {
      ...result.report,
      summary: { ...result.report.summary, totalAttempts: result.report.summary.totalAttempts + 1 }
    };
    expect(aggregate.verifyReportSignature(tamperedReport, reportSigner.publicKeyBase64)).toBe(false);

    const tamperedPath = join(committedDir, "acme", "api", "2026", "1-aaa.json");
    const tamperedRecord = {
      ...records[0],
      attempts: [{ ...records[0].attempts[0], detail: "tampered after aggregation" }]
    };
    writeFileSync(tamperedPath, `${JSON.stringify(tamperedRecord, null, 2)}\n`);
    const tamperedSourceRecords = await aggregate.loadEvidenceRecordsFromInputs([committedDir]);
    const mismatch = aggregate.findSourceRecordHashMismatches(result.report, tamperedSourceRecords, aggregateOptions(license, issuer, reportSigner));
    expect(mismatch.valid).toBe(false);
    expect(mismatch.missing).toHaveLength(1);
    expect(mismatch.added).toHaveLength(1);
  });

  it("reaggregates from a committed Evidence Record directory with the same result as artifact-like JSON files", async () => {
    const issuer = createIssuer("k1");
    const reportSigner = createReportSigner();
    const license = issueLicense(licensePayload({ maxRepos: 10 }), issuer.privateKey);
    const records = twentyFixtureRecords(license);
    const root = makeVerifyTempDir("aggregate-repro-");
    const artifactDir = writeRecords(join(root, "artifacts"), records, "flat");
    const committedDir = writeRecords(join(root, "evidence-records"), records, "committed");
    const options = aggregateOptions(license, issuer, reportSigner);

    const fromArtifacts = aggregate.aggregateEvidenceRecords(await aggregate.loadEvidenceRecordsFromInputs([artifactDir]), options);
    const fromCommitted = aggregate.aggregateEvidenceRecords(await aggregate.loadEvidenceRecordsFromInputs([committedDir]), options);

    expect(fromCommitted.report).toEqual(fromArtifacts.report);
    expect(fromCommitted.markdown).toBe(fromArtifacts.markdown);
  });

  it("documents the M4 collection, trust model, and D-1/D-2/D-3 boundaries", () => {
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
    const workflow = readFileSync(resolve(repoRoot, "evidence-repo-template/.github/workflows/collect-evidence.yml"), "utf8");

    expect(readme).toContain("SELF-ATTESTED evidence input");
    expect(readme).toContain("NOT an independent audit attestation");
    expect(readme).toContain("honor-system");
    expect(readme).toContain("Gitleaks/keygen-style");
    expect(readme).toContain("sourceRecordHashes");
    expect(readme).toContain("FCP_REPORT_SIGNING_KEY");
    expect(readme).toContain("artifact retention");
    expect(readme).toContain("릴리스 기반");
    expect(readme).toContain("실시간 revocation");
    expect(readme).toContain("owner.type");
    expect(readme).not.toContain("발급자 운영 대행");
    expect(readme).not.toContain("issuer-produced");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("evidence-records");
    expect(workflow).toContain("FCP_REPORT_SIGNING_KEY");
    expect(workflow).toContain("artifact retention");
    expect(workflow).not.toContain("pull_request");
    expect(workflow).not.toContain("push:");
  });
});

function aggregateOptions(license: IssuedLicense, issuer: ReturnType<typeof createIssuer>, reportSigner: ReturnType<typeof createReportSigner>) {
  return {
    licenseText: license.text,
    publicKeys: { [issuer.keyId]: issuer.publicKeyBase64, k2: issuer.publicKeyBase64 },
    reportSigningKey: reportSigner.privateKeyBase64,
    reportSigningKeyId: "test-report-key",
    generatedAt: "2026-02-01T00:00:00.000Z",
    now: "2026-02-01T00:00:00.000Z",
    quiet: true
  };
}

function twentyFixtureRecords(license: IssuedLicense) {
  return [
    evidenceRecord({ repo: "acme/api", prNumber: 1, headSha: "h01", actor: "alice", timestamp: "2026-01-05T10:00:00.000Z", attemptKinds: ["required_job_if_skip_risk", "required_config_narrowed"], weakeningKinds: ["run_count_drop"], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 2, headSha: "h02", actor: "bob", timestamp: "2026-01-06T10:00:00.000Z", attemptKinds: ["required_job_missing"], weakeningKinds: ["suppression_increase", "run_count_drop"], license }),
    evidenceRecord({ repo: "acme/infra", prNumber: 3, headSha: "h03", actor: "alice", timestamp: "2026-01-12T10:00:00.000Z", attemptKinds: ["required_job_if_skip_risk"], weakeningKinds: [], license }),
    evidenceRecord({ repo: "acme/api", prNumber: 4, headSha: "h04", actor: "carol", timestamp: "2026-01-13T10:00:00.000Z", attemptKinds: [], weakeningKinds: ["suppression_increase"], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 5, headSha: "h05", actor: "alice", timestamp: "2026-01-13T11:00:00.000Z", attemptKinds: ["required_workflow_trigger_narrowed", "required_job_if_added_review"], weakeningKinds: ["ignored_failure"], license }),
    evidenceRecord({ repo: "acme/infra", prNumber: 6, headSha: "h06", actor: "bob", timestamp: "2026-01-19T10:00:00.000Z", attemptKinds: ["required_config_narrowed"], weakeningKinds: [], license }),
    evidenceRecord({ repo: "acme/api", prNumber: 7, headSha: "h07", actor: "alice", timestamp: "2026-01-20T10:00:00.000Z", attemptKinds: ["required_job_if_skip_risk"], weakeningKinds: ["run_count_drop", "baseline_change"], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 8, headSha: "h08", actor: "dave", timestamp: "2026-01-20T11:00:00.000Z", attemptKinds: [], weakeningKinds: ["coverage_drop"], license }),
    evidenceRecord({ repo: "acme/infra", prNumber: 9, headSha: "h09", actor: "erin", timestamp: "2026-01-19T12:00:00.000Z", attemptKinds: ["required_job_missing", "required_job_missing"], weakeningKinds: [], license }),
    evidenceRecord({ repo: "acme/api", prNumber: 10, headSha: "h10", actor: "bob", timestamp: "2026-01-07T10:00:00.000Z", attemptKinds: ["required_job_if_added_review"], weakeningKinds: [], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 11, headSha: "h11", actor: "carol", timestamp: "2026-01-14T10:00:00.000Z", attemptKinds: ["required_job_if_skip_risk"], weakeningKinds: ["test_skip"], license }),
    evidenceRecord({ repo: "acme/infra", prNumber: 12, headSha: "h12", actor: "alice", timestamp: "2026-01-08T10:00:00.000Z", attemptKinds: [], weakeningKinds: ["env_missing"], license }),
    evidenceRecord({ repo: "acme/api", prNumber: 13, headSha: "h13", actor: "erin", timestamp: "2026-01-15T10:00:00.000Z", attemptKinds: ["required_config_narrowed"], weakeningKinds: [], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 14, headSha: "h14", actor: "alice", timestamp: "2026-01-20T12:00:00.000Z", attemptKinds: ["required_job_if_skip_risk"], weakeningKinds: ["suppression_increase"], license }),
    evidenceRecord({ repo: "acme/infra", prNumber: 15, headSha: "h15", actor: "bob", timestamp: "2026-01-15T11:00:00.000Z", attemptKinds: [], weakeningKinds: ["empty_assertion"], license }),
    evidenceRecord({ repo: "acme/api", prNumber: 16, headSha: "h16", actor: "carol", timestamp: "2026-01-10T10:00:00.000Z", attemptKinds: ["required_workflow_trigger_narrowed", "required_workflow_trigger_narrowed"], weakeningKinds: [], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 17, headSha: "h17", actor: "erin", timestamp: "2026-01-08T11:00:00.000Z", attemptKinds: ["required_job_missing"], weakeningKinds: ["ignored_failure"], license }),
    evidenceRecord({ repo: "acme/infra", prNumber: 18, headSha: "h18", actor: "dave", timestamp: "2026-01-16T10:00:00.000Z", attemptKinds: ["required_config_narrowed"], weakeningKinds: ["parse_failure"], license }),
    evidenceRecord({ repo: "acme/api", prNumber: 19, headSha: "h19", actor: "alice", timestamp: "2026-01-21T10:00:00.000Z", attemptKinds: [], weakeningKinds: ["guard_weakening", "other"], license }),
    evidenceRecord({ repo: "acme/web", prNumber: 20, headSha: "h20", actor: "bob", timestamp: "2026-01-21T11:00:00.000Z", attemptKinds: ["required_job_if_skip_risk", "required_job_if_skip_risk"], weakeningKinds: [], license })
  ];
}

function evidenceRecord({
  repo,
  prNumber = 1,
  headSha = "head",
  actor = "alice",
  timestamp = "2026-01-05T10:00:00.000Z",
  attemptKinds = ["required_job_if_skip_risk"],
  weakeningKinds = [],
  license
}: {
  repo: string;
  prNumber?: number;
  headSha?: string;
  actor?: string;
  timestamp?: string;
  attemptKinds?: string[];
  weakeningKinds?: string[];
  license: IssuedLicense | null;
}) {
  return {
    schemaVersion: "1.0",
    repo,
    prNumber,
    headSha,
    baseSha: `base-${headSha}`,
    actor,
    runId: `run-${prNumber}`,
    timestamp,
    verdict: attemptKinds.length > 0 ? "fail" : "pass",
    attempts: attemptKinds.map((kind, index) => ({
      kind,
      severity: kind === "required_job_if_added_review" ? "review" : "high",
      target: `${repo}:target-${index}`,
      detail: `${kind} detail`
    })),
    weakenings: weakeningKinds.map((kind, index) => ({
      kind,
      severity: "medium",
      target: `${repo}:weakening-${index}`,
      detail: `${kind} detail`
    })),
    detectorSummary: {
      total: attemptKinds.length + weakeningKinds.length,
      failed: attemptKinds.length,
      review: attemptKinds.filter((kind) => kind === "required_job_if_added_review").length,
      passed: 0
    },
    license: license
      ? {
          org: true,
          licenseId: license.payload.licenseId,
          signaturePresent: true
        }
      : {
          org: false,
          licenseId: null,
          signaturePresent: false
        },
    signature: license ? markerFor(license) : null
  };
}

function markerFor(license: IssuedLicense) {
  return {
    alg: "ed25519",
    keyId: license.payload.keyId,
    value: license.signature,
    markerType: "license-holder-org-proof",
    signedTarget: "issuer-license-payload",
    note: "This is a COPY of the issuer signature over the LICENSE payload. It does NOT sign this record body."
  };
}

function recordSource(record: unknown) {
  return {
    record,
    raw: `${JSON.stringify(record, null, 2)}\n`
  };
}

function writeRecords(root: string, records: ReturnType<typeof evidenceRecord>[], layout: "flat" | "committed") {
  mkdirSync(root, { recursive: true });
  records.forEach((record, index) => {
    const date = new Date(record.timestamp);
    const year = String(date.getUTCFullYear());
    const file =
      layout === "committed"
        ? join(root, record.repo, year, `${record.prNumber}-${record.headSha}.json`)
        : join(root, `${String(index + 1).padStart(2, "0")}-${record.prNumber}-${record.headSha}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  });
  return root;
}

function createIssuer(keyId: string): { keyId: string; privateKey: KeyObject; publicKeyBase64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
}

function createReportSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
}

function licensePayload(overrides: Partial<LicensePayload>): LicensePayload {
  return {
    licenseId: "lic_test",
    keyId: "k1",
    org: "acme",
    plan: "org-evidence",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    maxRepos: 10,
    ...overrides
  };
}

function issueLicense(payload: LicensePayload, privateKey: KeyObject): IssuedLicense {
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
  return {
    text: encodeLicenseEnvelope({ payload, signature }),
    payload,
    signature
  };
}
