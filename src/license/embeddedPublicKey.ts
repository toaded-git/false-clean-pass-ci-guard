export type EmbeddedPublicKeyMap = Readonly<Record<string, string>>;

export const embeddedPublicKeys: EmbeddedPublicKeyMap = {
  // keyId -> base64(SPKI DER Ed25519 public key). Issuer private keys are held by the
  // human issuer only. For key rotation (see DESIGN §8.5), add a new keyId entry in a
  // release; keep the old entry until its licenses expire, then remove it.
  key1: "MCowBQYDK2VwAyEAQkh/cYscROSGArfHp+IPhxgHJkzipsPB1E2uNEwEpEs="
};
