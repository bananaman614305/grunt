/**
 * Sub-keys are encrypted with the same envelope the billing store uses, so
 * whatever minted a key can be read back by whatever forwards it. This
 * module only re-exports; the implementation lives in @milo/billing.
 */
export { encryptSecret, decryptSecret, encryptionKeyFromEnv } from "@milo/billing";
