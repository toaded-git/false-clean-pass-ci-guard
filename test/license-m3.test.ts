import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/core/canonicalJson";
import { createEvidenceRecord } from "../src/core/evidenceRecord";
import type { RunResult } from "../src/core/types";
import { encodeLicenseEnvelope, verifyLicense, type LicenseEnvelope, type LicensePayload } from "../src/license/verify";
import { repoRoot } from "./helpers";

describe("M3 C-lite license verification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("canonicalizes JSON deterministically and includes keyId in signed payloads", () => {
    const left = {
      z: 1,
      payload: {
        org: "acme",
        keyId: "k1",
        nested: {
          b: true,
          a: ["x", "y"]
        }
      }
    };
    const right = {
      payload: {
        nested: {
          a: ["x", "y"],
          b: true
        },
        keyId: "k1",
        org: "acme"
      },
      z: 1
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe(
      '{"payload":{"keyId":"k1","nested":{"a":["x","y"],"b":true},"org":"acme"},"z":1}'
    );

    const issuer = createIssuer("k1");
    const payload = licensePayload({ keyId: "k1", org: "acme" });
    const license = issueLicense(payload, issuer.privateKey);
    const result = verifyLicense(license, {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys: { k1: issuer.publicKeyBase64 }
    });

    expect(result.valid).toBe(true);
    expect(result.valid && result.canonicalPayload).toBe(canonicalJson(payload));
  });

  it("passes a valid issuer signature", () => {
    const issuer = createIssuer("k1");
    const result = verifyLicense(issueLicense(licensePayload({ keyId: "k1", org: "acme" }), issuer.privateKey), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys: { k1: issuer.publicKeyBase64 }
    });

    expect(result.valid).toBe(true);
    expect(result.valid && result.payload.licenseId).toBe("lic_test");
  });

  it("fails when the payload is tampered after signing", () => {
    const issuer = createIssuer("k1");
    const license = issueLicense(licensePayload({ keyId: "k1", org: "acme" }), issuer.privateKey);
    const envelope = decodeLicense(license);
    envelope.payload.maxRepos = 999;

    const result = verifyLicense(encodeLicenseEnvelope(envelope), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys: { k1: issuer.publicKeyBase64 }
    });

    expect(result).toMatchObject({ valid: false, reason: "invalid_signature" });
  });

  it("fails expired and org-mismatched licenses", () => {
    const issuer = createIssuer("k1");
    const expired = verifyLicense(
      issueLicense(licensePayload({ keyId: "k1", org: "acme", expiresAt: "2026-01-01T00:00:00.000Z" }), issuer.privateKey),
      {
        org: "acme",
        now: new Date("2026-07-11T00:00:00.000Z"),
        publicKeys: { k1: issuer.publicKeyBase64 }
      }
    );
    const wrongOrg = verifyLicense(issueLicense(licensePayload({ keyId: "k1", org: "acme" }), issuer.privateKey), {
      org: "other",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys: { k1: issuer.publicKeyBase64 }
    });

    expect(expired).toMatchObject({ valid: false, reason: "expired" });
    expect(wrongOrg).toMatchObject({ valid: false, reason: "org_mismatch" });
  });

  it("does not call fetch, http, or https during verification", () => {
    const issuer = createIssuer("k1");
    const verifySource = readFileSync(resolve(repoRoot, "src/license/verify.ts"), "utf8");
    const fetchMock = vi.fn(() => {
      throw new Error("fetch must not be used");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = verifyLicense(issueLicense(licensePayload({ keyId: "k1", org: "acme" }), issuer.privateKey), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys: { k1: issuer.publicKeyBase64 }
    });

    expect(result.valid).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verifySource).not.toContain("node:http");
    expect(verifySource).not.toContain("node:https");
    expect(verifySource).not.toMatch(/\bfetch\s*\(/);
  });

  it("supports release-based key rollover and rejects unregistered or tampered keyIds", () => {
    const k1 = createIssuer("k1");
    const k2 = createIssuer("k2");
    const k9 = createIssuer("k9");
    const publicKeys = { k1: k1.publicKeyBase64, k2: k2.publicKeyBase64 };

    const oldKeyResult = verifyLicense(issueLicense(licensePayload({ keyId: "k1", org: "acme" }), k1.privateKey), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys
    });

    const unregistered = verifyLicense(issueLicense(licensePayload({ keyId: "k9", org: "acme" }), k9.privateKey), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys
    });

    const tamperedEnvelope = decodeLicense(issueLicense(licensePayload({ keyId: "k1", org: "acme" }), k1.privateKey));
    tamperedEnvelope.payload.keyId = "k2";
    const tamperedKeyId = verifyLicense(encodeLicenseEnvelope(tamperedEnvelope), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys
    });

    expect(oldKeyResult.valid).toBe(true);
    expect(unregistered).toMatchObject({ valid: false, reason: "unregistered_key" });
    expect(tamperedKeyId).toMatchObject({ valid: false, reason: "invalid_signature" });
  });

  it("keeps personal or unlicensed contexts unsigned and signs organization records with a valid license marker", () => {
    const issuer = createIssuer("k1");
    const verification = verifyLicense(issueLicense(licensePayload({ keyId: "k1", org: "acme" }), issuer.privateKey), {
      org: "acme",
      now: new Date("2026-07-11T00:00:00.000Z"),
      publicKeys: { k1: issuer.publicKeyBase64 }
    });
    expect(verification.valid).toBe(true);

    const personal = createEvidenceRecord({
      result: runResult(),
      repo: "acme/repo",
      prNumber: 1,
      headSha: "head",
      ownerType: "User",
      licenseVerification: verification
    });
    const organization = createEvidenceRecord({
      result: runResult(),
      repo: "acme/repo",
      prNumber: 1,
      headSha: "head",
      ownerType: "Organization",
      licenseVerification: verification
    });
    const unlicensedOrganization = createEvidenceRecord({
      result: runResult(),
      repo: "acme/repo",
      prNumber: 1,
      headSha: "head",
      ownerType: "Organization"
    });

    expect(personal.license).toEqual({ org: false, licenseId: null, signaturePresent: false });
    expect(personal.signature).toBeNull();
    expect(unlicensedOrganization.license).toEqual({ org: false, licenseId: null, signaturePresent: false });
    expect(unlicensedOrganization.signature).toBeNull();
    expect(organization.license).toEqual({ org: true, licenseId: "lic_test", signaturePresent: true });
    expect(organization.signature).toMatchObject({
      alg: "ed25519",
      keyId: "k1",
      value: verification.valid ? verification.signature : ""
    });
    expect(organization.detectorSummary).toEqual({ total: 3, failed: 1, review: 1, passed: 1 });

    const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/evidence-record.schema.json"), "utf8")) as object;
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    expect(validate(organization), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("documents the honor-system gate, signature caveat, and release-based rollover", () => {
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

    expect(readme).toContain("honor-system");
    expect(readme).toContain("owner.type");
    expect(readme).toContain("무결성 보조");
    expect(readme).toContain("감사 신뢰");
    expect(readme).toContain("Gitleaks/keygen-style");
    expect(readme).toContain("organization-scope aggregation");
    expect(readme).toContain("실시간 revocation");
    expect(readme).toContain("릴리스 기반");
  });
});

function createIssuer(keyId: string): { keyId: string; privateKey: KeyObject; publicKeyBase64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64")
  };
}

function licensePayload(overrides: Partial<LicensePayload>): LicensePayload {
  return {
    licenseId: "lic_test",
    keyId: "k1",
    org: "acme",
    plan: "org-evidence",
    issuedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2027-07-01T00:00:00.000Z",
    maxRepos: 50,
    ...overrides
  };
}

function issueLicense(payload: LicensePayload, privateKey: KeyObject): string {
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
  return encodeLicenseEnvelope({ payload, signature });
}

function decodeLicense(license: string): LicenseEnvelope {
  return JSON.parse(Buffer.from(license, "base64").toString("utf8")) as LicenseEnvelope;
}

function runResult(): RunResult {
  return {
    findings: [
      {
        detector: "failed-detector",
        severity: "error",
        ruleId: "false-clean-pass/test-error",
        message: "failed"
      },
      {
        detector: "review-detector",
        severity: "warning",
        ruleId: "false-clean-pass/test-review",
        message: "review"
      }
    ],
    errorCount: 1,
    warningCount: 1,
    result: "fail",
    detectorResults: [
      { id: "failed-detector", status: "fail" },
      { id: "review-detector", status: "review" },
      { id: "passed-detector", status: "pass" }
    ]
  };
}
