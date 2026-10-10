/**
 * Fixture tests for the e-invoice credential box.
 *
 *   node scripts/secret-box.test.mjs
 *
 * What is stored here is a password that files tax documents in somebody
 * else's name. So the tests are about the ways encryption goes wrong in
 * practice rather than about AES:
 *
 *   1. It must not share a key with anything else. A leaked AUTH_SECRET
 *      forges sessions; it must not also open every firm's portal password.
 *   2. A short or missing key must be refused loudly, not quietly turned into
 *      a weak one -- protection that is not protection is worse than none.
 *   3. An edited ciphertext must fail, not decrypt to rubbish, and a failure
 *      must never hand back a plaintext or echo the stored value.
 *   4. A blob copied from one firm's row to another's must not open.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SEAL_PREFIX,
  SecretBoxError,
  generateKeyHex,
  isSealed,
  keyFrom,
  keyFromEnv,
  open,
  sameSecret,
  seal,
  secretBoxReady,
  tryOpen,
} from "../lib/secretBox.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const KEY = generateKeyHex();
const OTHER_KEY = generateKeyHex();
const FIRM = "66f1c0ffee0000000000abcd";
const PASSWORD = "P0rtal!Secret#2026";

console.log("\n--- it round-trips ---");

test("what goes in comes out", () => {
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  assert.equal(open(sealed, { key: KEY, aad: FIRM }), PASSWORD);
});

test("unicode, spaces and a very long secret all survive", () => {
  for (const secret of ["पासवर्ड", "  spaces kept  ", "x".repeat(4000), "a$b$c$d$e"]) {
    const sealed = seal(secret, { key: KEY, aad: FIRM });
    assert.equal(open(sealed, { key: KEY, aad: FIRM }), secret, JSON.stringify(secret.slice(0, 20)));
  }
});

test("the same password seals differently every time", () => {
  // Otherwise the column tells you which firms share a password.
  const a = seal(PASSWORD, { key: KEY, aad: FIRM });
  const b = seal(PASSWORD, { key: KEY, aad: FIRM });
  assert.notEqual(a, b);
  assert.equal(open(a, { key: KEY, aad: FIRM }), open(b, { key: KEY, aad: FIRM }));
});

test("the stored form is recognisable and carries no plaintext", () => {
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  assert.ok(sealed.startsWith(`${SEAL_PREFIX}$1$`));
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes(PASSWORD));
  assert.ok(!sealed.includes("Portal"));
  assert.equal(sealed.split("$").length, 5);
});

test("a value that was never encrypted says exactly that", () => {
  // Distinct from a decryption failure: this one is obvious from the input
  // itself, so saying so helps whoever is looking at the column.
  try {
    open("not encrypted at all", { key: KEY, aad: FIRM });
    assert.fail("it should have thrown");
  } catch (err) {
    assert.match(err.message, /not an encrypted value/);
  }
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  try {
    open(sealed, { key: OTHER_KEY, aad: FIRM });
  } catch (err) {
    assert.doesNotMatch(err.message, /not an encrypted value/);
  }
});

test("junk is not mistaken for a sealed value", () => {
  for (const value of ["", null, undefined, "password123", "aesgcm$1$short", "aesgcm$2$a$b$c", "scrypt$1$a$b$c"]) {
    assert.equal(isSealed(value), false, JSON.stringify(value));
    assert.equal(tryOpen(value, { key: KEY, aad: FIRM }), null);
  }
});

test("there is nothing to encrypt is an error, not an empty blob", () => {
  for (const value of ["", null, undefined]) {
    assert.throws(() => seal(value, { key: KEY }), SecretBoxError);
  }
});

console.log("\n--- a wrong key, a wrong firm, an edited blob ---");

test("another key does not open it", () => {
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  assert.equal(tryOpen(sealed, { key: OTHER_KEY, aad: FIRM }), null);
  assert.throws(() => open(sealed, { key: OTHER_KEY, aad: FIRM }), SecretBoxError);
});

test("another firm's row does not open it", () => {
  // The id is authenticated, so a blob copied between rows is useless.
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  assert.equal(tryOpen(sealed, { key: KEY, aad: "some-other-firm" }), null);
  assert.equal(tryOpen(sealed, { key: KEY }), null, "no firm at all is also wrong");
});

test("every part of the blob is authenticated", () => {
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  const [prefix, version, iv, tag, ct] = sealed.split("$");
  const flip = (b64) => {
    const buf = Buffer.from(b64, "base64");
    buf[0] = buf[0] ^ 0xff;
    return buf.toString("base64");
  };
  const edited = [
    [prefix, version, flip(iv), tag, ct].join("$"),
    [prefix, version, iv, flip(tag), ct].join("$"),
    [prefix, version, iv, tag, flip(ct)].join("$"),
  ];
  for (const blob of edited) {
    assert.equal(tryOpen(blob, { key: KEY, aad: FIRM }), null, blob.slice(0, 20));
  }
});

test("a truncated blob fails rather than half-decrypting", () => {
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  const [prefix, version, iv, tag, ct] = sealed.split("$");
  assert.equal(tryOpen([prefix, version, iv, tag, ct.slice(0, 8)].join("$"), { key: KEY, aad: FIRM }), null);
  assert.equal(tryOpen([prefix, version, iv.slice(0, 6), tag, ct].join("$"), { key: KEY, aad: FIRM }), null);
  assert.equal(tryOpen([prefix, version, iv, tag.slice(0, 6), ct].join("$"), { key: KEY, aad: FIRM }), null);
});

test("a failure says nothing about what was stored", () => {
  const sealed = seal(PASSWORD, { key: KEY, aad: FIRM });
  try {
    open(sealed, { key: OTHER_KEY, aad: FIRM });
    assert.fail("it should have thrown");
  } catch (err) {
    assert.ok(!err.message.includes(PASSWORD));
    assert.ok(!err.message.includes(sealed));
    assert.ok(!err.message.includes(KEY));
    // The same message for a wrong key and an edited blob: telling them apart
    // is information worth withholding.
    try {
      open(sealed.slice(0, -4) + "AAAA", { key: KEY, aad: FIRM });
    } catch (other) {
      assert.equal(other.message, err.message);
    }
  }
});

console.log("\n--- the key itself ---");

test("a generated key is 64 hex characters and unique each time", () => {
  const a = generateKeyHex();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, generateKeyHex());
  assert.doesNotThrow(() => keyFrom(a));
});

test("hex and base64 are both accepted", () => {
  const hex = generateKeyHex();
  const b64 = Buffer.from(hex, "hex").toString("base64");
  const sealed = seal(PASSWORD, { key: hex, aad: FIRM });
  assert.equal(open(sealed, { key: b64, aad: FIRM }), PASSWORD, "the same key, written two ways");
});

test("a short or weak key is refused, never stretched", () => {
  // A passphrase quietly padded into a key is the failure this guards: it
  // looks encrypted and is not.
  for (const bad of ["", "   ", "hunter2", "password", "0".repeat(63), "0".repeat(65), "zz".repeat(32), null]) {
    assert.throws(() => keyFrom(bad), SecretBoxError, JSON.stringify(bad));
  }
});

test("the error says how to make a key", () => {
  try {
    keyFrom("");
    assert.fail("it should have thrown");
  } catch (err) {
    assert.match(err.message, /EINVOICE_KEY/);
    assert.match(err.message, /randomBytes\(32\)/);
  }
});

test("AUTH_SECRET is not a fallback, however tempting", () => {
  // The whole point of a separate key: one leaked secret must not both forge
  // sessions and decrypt every firm's portal password.
  const secret = generateKeyHex();
  const env = { AUTH_SECRET: secret };

  assert.throws(() => keyFromEnv(env), SecretBoxError);
  assert.equal(secretBoxReady(env), false);

  // The exact message, because the two edits that would wire AUTH_SECRET in
  // are each individually harmless -- dropping the guard leaves the key read
  // failing, and widening the key read leaves the guard refusing -- so only
  // the specific wording and the sweep below tell them apart.
  try {
    keyFromEnv(env);
    assert.fail("it should have thrown");
  } catch (err) {
    assert.match(err.message, /EINVOICE_KEY is not configured on the server/);
    assert.doesNotMatch(err.message, /AUTH_SECRET/);
  }

  // And nothing sealed with that value as a key opens through the environment.
  const sealed = seal(PASSWORD, { key: secret, aad: FIRM });
  assert.equal(tryOpen(sealed, { aad: FIRM, env }), null);
  assert.throws(() => seal(PASSWORD, { aad: FIRM, env }), SecretBoxError);
});

test("the session secret is not named anywhere in the code", () => {
  // The belt to the braces above: a fallback cannot be added by accident
  // without this failing.
  const src = fs.readFileSync(new URL("../lib/secretBox.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /AUTH_SECRET/, "secretBox must not read the session secret");
  assert.match(code, /EINVOICE_KEY/);
});

test("a passed environment is used, not the process's own", () => {
  // The route hands this an env so a test can run without touching the real
  // one. If the parameter were ignored, a server that happens to have a key
  // configured would make these tests pass for the wrong reason.
  const processKey = generateKeyHex();
  const passedKey = generateKeyHex();
  const previous = process.env.EINVOICE_KEY;
  process.env.EINVOICE_KEY = processKey;
  try {
    const env = { EINVOICE_KEY: passedKey };
    const sealed = seal(PASSWORD, { aad: FIRM, env });
    assert.equal(open(sealed, { aad: FIRM, env }), PASSWORD);
    // Sealed under the passed key, so the process's own key must not open it.
    assert.equal(tryOpen(sealed, { aad: FIRM }), null);
    assert.equal(open(sealed, { key: passedKey, aad: FIRM }), PASSWORD);
  } finally {
    if (previous === undefined) delete process.env.EINVOICE_KEY;
    else process.env.EINVOICE_KEY = previous;
  }
});

test("the configured key is read from the environment", () => {
  const env = { EINVOICE_KEY: generateKeyHex() };
  assert.equal(secretBoxReady(env), true);
  assert.equal(keyFromEnv(env).length, 32);
  assert.equal(secretBoxReady({}), false);
  assert.equal(secretBoxReady({ EINVOICE_KEY: "too short" }), false);
});

console.log("\n--- comparing a secret ---");

test("sameSecret matches only an exact match", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "ab"), false);
  assert.equal(sameSecret("", ""), true);
  assert.equal(sameSecret(null, ""), true, "null and empty are both nothing");
  assert.equal(sameSecret("abc", null), false);
});

console.log(`\n${passed} checks passed.\n`);
