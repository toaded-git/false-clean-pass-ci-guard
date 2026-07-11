export type EmbeddedPublicKeyMap = Readonly<Record<string, string>>;

export const embeddedPublicKeys: EmbeddedPublicKeyMap = {
  // Placeholder only. Before a production release, a human issuer must replace/add
  // real keyId -> base64(SPKI DER Ed25519 public key) entries here.
  "release-key-placeholder": "REPLACE_WITH_BASE64_DER_SPKI_ED25519_PUBLIC_KEY"
};
