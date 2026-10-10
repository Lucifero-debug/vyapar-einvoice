/**
 * Password hashing.
 *
 * Uses node's built-in scrypt -- no npm dependency, so `node` can run the
 * fixture test directly and there is no bcrypt native build to go wrong on a
 * Windows machine.
 *
 * WHAT IS STORED
 * --------------
 *   scrypt$N$r$p$keylen$salthex$hashhex
 *
 * The parameters travel with the hash rather than living in a constant, so
 * raising the cost later does not lock anybody out: old hashes keep verifying
 * against the parameters they were made with, and `needsRehash()` says which
 * ones to upgrade on next sign-in.
 *
 * Verification is a constant-time compare. A plain === leaks, through how long
 * it takes to fail, how much of the hash was right.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
// A real import, not `export ... from`: hashPassword() calls passwordProblem
// below, and a bare re-export does not bind the name locally. That exact
// mistake has already cost this project a ReferenceError at runtime once.
import { MIN_PASSWORD_LENGTH, passwordProblem } from "./passwordRules.mjs";

// Re-exported so every existing caller keeps importing these from here.
export { MIN_PASSWORD_LENGTH, passwordProblem };

const scrypt = promisify(scryptCb);

// cost 2^16, the Node default block size and parallelism. Takes roughly a
// tenth of a second, which is slow enough to matter to a guesser and fast
// enough that a shopkeeper does not notice it.
export const DEFAULT_PARAMS = { N: 65536, r: 8, p: 1, keylen: 64 };

const SALT_BYTES = 16;

/** Hash a password. Returns the string to store. */
export async function hashPassword(password, params = DEFAULT_PARAMS) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const { N, r, p, keylen } = params;
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password.normalize("NFKC"), salt, keylen, {
    N,
    r,
    p,
    // Node's default maxmem is too small for N=65536; without this it throws.
    maxmem: 256 * N * r,
  });

  return [
    "scrypt",
    N,
    r,
    p,
    keylen,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

/** Parse a stored hash, or null when it is not one we wrote. */
export function parseHash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return null;

  const [, N, r, p, keylen, saltHex, hashHex] = parts;
  const nums = { N: Number(N), r: Number(r), p: Number(p), keylen: Number(keylen) };
  if (Object.values(nums).some((n) => !Number.isInteger(n) || n <= 0)) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  if (hashHex.length !== nums.keylen * 2) return null;

  return { ...nums, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

/**
 * Is this the right password? Never throws -- a malformed stored hash is a
 * failed sign-in, not a 500 that tells the caller something interesting.
 */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== "string") return false;

  try {
    const { N, r, p, keylen, salt, hash } = parsed;
    const candidate = await scrypt(password.normalize("NFKC"), salt, keylen, {
      N,
      r,
      p,
      maxmem: 256 * N * r,
    });
    return candidate.length === hash.length && timingSafeEqual(candidate, hash);
  } catch {
    return false;
  }
}

/** Was this hash made with weaker parameters than we now use? */
export function needsRehash(stored, params = DEFAULT_PARAMS) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return (
    parsed.N < params.N ||
    parsed.r < params.r ||
    parsed.p < params.p ||
    parsed.keylen < params.keylen
  );
}
