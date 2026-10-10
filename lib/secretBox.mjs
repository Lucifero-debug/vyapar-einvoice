/**
 * Encrypting one small secret at rest — the e-invoice portal password.
 *
 * WHY THIS IS NOT lib/password.mjs
 *
 * A user's own password is hashed: nothing ever needs to read it back. The
 * portal password is different. It has to be sent to the IRP on every token
 * refresh, so it has to be recoverable, which means encryption rather than
 * hashing.
 *
 * WHY ITS OWN KEY, and not AUTH_SECRET
 *
 * AUTH_SECRET signs sessions. If one leaked secret both forged sessions AND
 * decrypted every customer's portal password, a single mistake would let
 * somebody file invoices as your customers -- which is their tax record, not
 * just their data. So this reads `EINVOICE_KEY`, and deliberately will not
 * fall back to anything.
 *
 * AES-256-GCM, so a ciphertext that has been edited fails to open rather than
 * decrypting to rubbish. The company's id goes in as additional authenticated
 * data, which means a blob copied from one firm's row into another's does not
 * open either.
 *
 *     const sealed = seal(password, { aad: companyId });
 *     const plain  = open(sealed,   { aad: companyId });
 *
 * SERVER ONLY. It imports node:crypto, so a 'use client' page that imports it
 * breaks the build -- see PROJECT_CONTEXT.md section 6. The profile form posts
 * the password and the route seals it.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** How a sealed value is recognised, and what version of the format it is. */
export const SEAL_PREFIX = "aesgcm";
export const SEAL_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, which is what GCM is specified for
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/* -------------------------------------------------------------------- key -- */

/**
 * A 32-byte key from a hex or base64 string.
 *
 * Nothing is derived from a short passphrase here on purpose: a key that can
 * be guessed is worse than no encryption, because it reads as protection.
 */
export const keyFrom = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new SecretBoxError(
      "EINVOICE_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) key = Buffer.from(raw, "base64");

  if (!key || key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `EINVOICE_KEY must be 32 bytes, as 64 hex characters or 44 base64 characters. Got ${raw.length} characters.`
    );
  }
  return key;
};

/** The key this server is configured with. Throws rather than guessing. */
export const keyFromEnv = (env = process.env) => {
  // Explicitly NOT falling back to AUTH_SECRET: see the note at the top.
  if (!env.EINVOICE_KEY) {
    throw new SecretBoxError(
      "EINVOICE_KEY is not configured on the server, so e-invoice credentials cannot be stored."
    );
  }
  return keyFrom(env.EINVOICE_KEY);
};

/** A fresh key to put in .env.local, as hex. */
export const generateKeyHex = () => randomBytes(KEY_BYTES).toString("hex");

/** Is a key configured at all? For a settings page that wants to say so. */
export const secretBoxReady = (env = process.env) => {
  try {
    keyFromEnv(env);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------- seal -- */

const aadBuffer = (aad) => Buffer.from(String(aad ?? ""), "utf8");

/**
 * Encrypt a string. The result is safe to store in a plain column.
 *
 *   aesgcm$1$<iv base64>$<tag base64>$<ciphertext base64>
 *
 * A fresh random IV every time, so sealing the same password twice gives two
 * different blobs -- otherwise the column would quietly reveal which firms
 * share a password.
 */
export const seal = (plaintext, { key, aad = "", env } = {}) => {
  const value = String(plaintext ?? "");
  if (!value) throw new SecretBoxError("There is nothing to encrypt.");

  const k = key ? keyFrom(key) : keyFromEnv(env || process.env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  cipher.setAAD(aadBuffer(aad));

  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    SEAL_PREFIX,
    SEAL_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join("$");
};

/** Does this look like something seal() produced? */
export const isSealed = (value) => {
  const parts = String(value || "").split("$");
  return parts.length === 5 && parts[0] === SEAL_PREFIX && parts[1] === String(SEAL_VERSION);
};

/**
 * Decrypt. Throws when the blob has been edited, when the key is wrong, or
 * when it belongs to another firm.
 *
 * There is no partial success: GCM verifies the tag before `final()` returns,
 * so a failure never yields plaintext, and nothing here echoes the stored
 * value into the error.
 */
export const open = (sealed, { key, aad = "", env } = {}) => {
  const raw = String(sealed || "");
  if (!isSealed(raw)) throw new SecretBoxError("That is not an encrypted value.");

  const [, , ivB64, tagB64, ctB64] = raw.split("$");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError("The encrypted value is malformed.");
  }

  const k = key ? keyFrom(key) : keyFromEnv(env || process.env);

  try {
    const decipher = createDecipheriv(ALGORITHM, k, iv);
    decipher.setAAD(aadBuffer(aad));
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
  } catch {
    // One message for a wrong key, an edited blob and the wrong firm alike:
    // telling them apart is information an attacker would use.
    throw new SecretBoxError("Could not decrypt the stored value.");
  }
};

/** The same, as null instead of an exception, for a caller that expects misses. */
export const tryOpen = (sealed, options) => {
  try {
    return open(sealed, options);
  } catch {
    return null;
  }
};

/** Constant-time string comparison, for checking a secret somebody sent back. */
export const sameSecret = (a, b) => {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};
