import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { canonicalJson } from "../core/canonicalJson";
import { embeddedPublicKeys, type EmbeddedPublicKeyMap } from "./embeddedPublicKey";

export interface LicensePayload {
  licenseId: string;
  keyId: string;
  org: string;
  plan: string;
  issuedAt: string;
  expiresAt: string;
  maxRepos: number;
}

export interface LicenseEnvelope {
  payload: LicensePayload;
  signature: string;
}

export type LicenseVerificationReason =
  | "missing"
  | "malformed"
  | "unregistered_key"
  | "invalid_public_key"
  | "invalid_signature"
  | "expired"
  | "org_mismatch";

export type LicenseVerificationResult =
  | {
      valid: true;
      payload: LicensePayload;
      signature: string;
      canonicalPayload: string;
    }
  | {
      valid: false;
      reason: LicenseVerificationReason;
      message: string;
      payload?: Partial<LicensePayload>;
    };

export interface VerifyLicenseOptions {
  org: string;
  now?: Date;
  publicKeys?: EmbeddedPublicKeyMap;
}

export function verifyLicense(licenseText: string | undefined, options: VerifyLicenseOptions): LicenseVerificationResult {
  if (!licenseText || !licenseText.trim()) {
    return invalid("missing", "FCP_LICENSE is not set.");
  }

  const envelope = decodeLicenseEnvelope(licenseText);
  if (!envelope) {
    return invalid("malformed", "FCP_LICENSE must be base64 JSON with payload and signature.");
  }

  const publicKeyBase64 = (options.publicKeys ?? embeddedPublicKeys)[envelope.payload.keyId];
  if (!publicKeyBase64) {
    return invalid("unregistered_key", `License keyId '${envelope.payload.keyId}' is not registered.`, envelope.payload);
  }

  const canonicalPayload = canonicalJson(envelope.payload);
  const publicKey = createEd25519PublicKey(publicKeyBase64);
  if (!publicKey) {
    return invalid("invalid_public_key", `Embedded public key for '${envelope.payload.keyId}' is not usable.`, envelope.payload);
  }

  const signature = Buffer.from(envelope.signature, "base64");
  let verified = false;
  try {
    verified = cryptoVerify(null, Buffer.from(canonicalPayload, "utf8"), publicKey, signature);
  } catch {
    verified = false;
  }
  if (!verified) {
    return invalid("invalid_signature", "License signature verification failed.", envelope.payload);
  }

  const expiresAt = Date.parse(envelope.payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? new Date()).getTime()) {
    return invalid("expired", "License is expired.", envelope.payload);
  }

  if (!sameGitHubOwner(envelope.payload.org, options.org)) {
    return invalid("org_mismatch", `License org '${envelope.payload.org}' does not match '${options.org}'.`, envelope.payload);
  }

  return {
    valid: true,
    payload: envelope.payload,
    signature: envelope.signature,
    canonicalPayload
  };
}

export function encodeLicenseEnvelope(envelope: LicenseEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function decodeLicenseEnvelope(licenseText: string): LicenseEnvelope | undefined {
  try {
    const decoded = Buffer.from(licenseText.trim(), "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isLicenseEnvelope(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isLicenseEnvelope(value: unknown): value is LicenseEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const envelope = value as { payload?: unknown; signature?: unknown };
  if (!envelope.payload || typeof envelope.payload !== "object" || typeof envelope.signature !== "string") {
    return false;
  }

  const payload = envelope.payload as Partial<LicensePayload>;
  return (
    typeof payload.licenseId === "string" &&
    typeof payload.keyId === "string" &&
    typeof payload.org === "string" &&
    typeof payload.plan === "string" &&
    typeof payload.issuedAt === "string" &&
    typeof payload.expiresAt === "string" &&
    typeof payload.maxRepos === "number"
  );
}

function createEd25519PublicKey(publicKeyBase64: string) {
  try {
    return createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki"
    });
  } catch {
    return undefined;
  }
}

function invalid(
  reason: LicenseVerificationReason,
  message: string,
  payload?: Partial<LicensePayload>
): LicenseVerificationResult {
  return payload ? { valid: false, reason, message, payload } : { valid: false, reason, message };
}

function sameGitHubOwner(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
