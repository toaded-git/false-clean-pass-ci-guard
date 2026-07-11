#!/usr/bin/env node
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { canonicalJson } = loadCanonicalJson();

const args = parseArgs(process.argv.slice(2));
const privateKeyText = process.env.FCP_ISSUER_PRIVATE_KEY;

if (args.help) {
  printUsage();
  process.exit(0);
}

for (const name of ["org", "key-id", "expires-at"]) {
  if (!args[name]) {
    fail(`Missing required --${name}.`);
  }
}

if (!privateKeyText) {
  fail("Missing FCP_ISSUER_PRIVATE_KEY. Set it to a PEM private key or base64(PKCS8 DER) private key.");
}

const maxRepos = args["max-repos"] ? Number(args["max-repos"]) : 1;
if (!Number.isInteger(maxRepos) || maxRepos < 1) {
  fail("--max-repos must be a positive integer.");
}

const payload = {
  licenseId: args["license-id"] || `lic_${randomUUID().replaceAll("-", "")}`,
  keyId: required(args["key-id"]),
  org: required(args.org),
  plan: args.plan || "org-evidence",
  issuedAt: args["issued-at"] || new Date().toISOString(),
  expiresAt: required(args["expires-at"]),
  maxRepos
};

const privateKey = parsePrivateKey(privateKeyText);
const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
const license = Buffer.from(JSON.stringify({ payload, signature }), "utf8").toString("base64");
process.stdout.write(`${license}\n`);

function loadCanonicalJson() {
  try {
    return require("../build/core/canonicalJson.js");
  } catch (error) {
    fail(`Unable to load build/core/canonicalJson.js. Run npm run build before issuing licenses. ${error.message}`);
  }
}

function parsePrivateKey(value) {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return createPrivateKey(trimmed);
  }
  return createPrivateKey({
    key: Buffer.from(trimmed, "base64"),
    format: "der",
    type: "pkcs8"
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      fail(`Unknown argument: ${arg}`);
    }
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${arg}.`);
    }
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function required(value) {
  if (!value) {
    throw new Error("Required value missing.");
  }
  return value;
}

function printUsage() {
  process.stdout.write(`Usage:
  FCP_ISSUER_PRIVATE_KEY=<pem-or-base64-pkcs8-der> node tools/issue-license.mjs \\
    --org acme \\
    --key-id k1 \\
    --expires-at 2027-07-01T00:00:00.000Z \\
    [--plan org-evidence] \\
    [--max-repos 50] \\
    [--license-id lic_xxx] \\
    [--issued-at 2026-07-01T00:00:00.000Z]

The selected --key-id must match the public key entry released in embeddedPublicKeys.
`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
