/**
 * Fixture tests for the e-invoice portal settings.
 *
 *   node scripts/einvoice-credentials.test.mjs
 *
 * The one thing that must not happen here is the password coming back out.
 * Everything the browser is told about it is a boolean, and these tests pin
 * that down -- along with the sandbox-by-default rule, because the mistake
 * that costs real money is filing a test invoice against the live portal.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CREDENTIAL_FIELDS,
  EINVOICE_DEFAULT_ENV,
  EINVOICE_ENVS,
  credentialProblems,
  credentialState,
  credentialsReady,
  normalizeEnv,
} from "../lib/einvoiceCredentials.mjs";

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

const SEALED = "aesgcm$1$aXZpdml2aXZpdml2$dGFndGFndGFndGFndGFn$Y2lwaGVy";

const FIRM = {
  einvoiceEnabled: true,
  einvoiceUsername: "suryavansh_api",
  einvoiceEnv: "sandbox",
  einvoicePasswordEnc: SEALED,
};

console.log("\n--- the password never comes back out ---");

test("the state the browser sees is a boolean, not a value", () => {
  const state = credentialState(FIRM);
  assert.deepEqual(state, {
    enabled: true,
    username: "suryavansh_api",
    env: "sandbox",
    passwordSet: true,
  });
  const serialised = JSON.stringify(state);
  assert.ok(!serialised.includes(SEALED), "the sealed blob reached the browser");
  assert.ok(!serialised.includes("aesgcm"));
  assert.ok(!("password" in state));
  assert.ok(!("einvoicePasswordEnc" in state));
});

test("no stored password reads as not set", () => {
  assert.equal(credentialState({ ...FIRM, einvoicePasswordEnc: "" }).passwordSet, false);
  assert.equal(credentialState({ ...FIRM, einvoicePasswordEnc: "   " }).passwordSet, false);
  assert.equal(credentialState({ ...FIRM, einvoicePasswordEnc: null }).passwordSet, false);
  assert.equal(credentialState({}).passwordSet, false);
  assert.equal(credentialState(null).passwordSet, false);
});

test("the password column is not in the list of fields a route projects", () => {
  // CREDENTIAL_FIELDS is what an ordinary query asks for. The sealed column is
  // select:false and has to be named explicitly, which is the point.
  assert.ok(!CREDENTIAL_FIELDS.includes("einvoicePasswordEnc"));
  assert.deepEqual(CREDENTIAL_FIELDS, ["einvoiceEnabled", "einvoiceUsername", "einvoiceEnv"]);
});

test("this module never touches node:crypto", () => {
  // It is imported by a 'use client' page. One import of secretBox here and
  // the client bundle breaks -- which is how the signup page broke before.
  const src = fs.readFileSync(new URL("../lib/einvoiceCredentials.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /node:crypto|secretBox|require\(/);
  assert.doesNotMatch(code, /^import/m, "it should have no imports at all");
});

console.log("\n--- sandbox unless somebody says otherwise ---");

test("there are two portals and the default is the safe one", () => {
  assert.deepEqual(EINVOICE_ENVS.map((e) => e.value), ["sandbox", "production"]);
  assert.equal(EINVOICE_DEFAULT_ENV, "sandbox");
  assert.equal(EINVOICE_ENVS[0].value, EINVOICE_DEFAULT_ENV, "the first option is the default");
});

test("anything unrecognised falls back to the sandbox, never to production", () => {
  for (const value of ["", null, undefined, "staging", "live", "prod", "PRODUCTIO", 1]) {
    assert.equal(normalizeEnv(value), "sandbox", JSON.stringify(value));
  }
  assert.equal(normalizeEnv("PRODUCTION"), "production");
  assert.equal(normalizeEnv(" Production "), "production");
  assert.equal(normalizeEnv("sandbox"), "sandbox");
});

test("a bad portal value is reported, not silently corrected", () => {
  const problems = credentialProblems({ env: "live" });
  assert.deepEqual(problems.map((p) => p.field), ["env"]);
  assert.deepEqual(credentialProblems({ env: "production" }), []);
  assert.deepEqual(credentialProblems({ env: "" }), []);
});

console.log("\n--- switching it on is what demands a full set ---");

test("everything may be blank while it is off", () => {
  assert.deepEqual(credentialProblems({}), []);
  assert.deepEqual(credentialProblems({ enabled: false }), []);
  assert.deepEqual(credentialProblems({ enabled: false, username: "", password: "" }), []);
});

test("switching it on without a username or password is refused", () => {
  const problems = credentialProblems({ enabled: true });
  assert.deepEqual(problems.map((p) => p.field), ["username", "password"]);
  for (const p of problems) assert.match(p.message, /to file invoices/);
});

test("a password already stored counts; a blank field does not wipe it", () => {
  assert.deepEqual(
    credentialProblems({ enabled: true, username: "suryavansh_api" }, { passwordSet: true }),
    []
  );
  assert.deepEqual(
    credentialProblems({ enabled: true, username: "suryavansh_api", password: "" }, { passwordSet: true }),
    []
  );
  assert.deepEqual(
    credentialProblems({ enabled: true, username: "suryavansh_api" }, { passwordSet: false }).map((p) => p.field),
    ["password"]
  );
});

test("a username of spaces is no username", () => {
  assert.deepEqual(
    credentialProblems({ enabled: true, username: "   ", password: "x" }).map((p) => p.field),
    ["username"]
  );
});

test("the database's own field names are accepted as well as the form's", () => {
  // The route validates the body; a direct POST may use either shape.
  assert.deepEqual(
    credentialProblems({ einvoiceEnabled: true, einvoiceUsername: "api", password: "x" }),
    []
  );
  assert.deepEqual(
    credentialProblems({ einvoiceEnabled: true }).map((p) => p.field),
    ["username", "password"]
  );
});

console.log("\n--- ready to reach the portal ---");

test("ready means switched on, named, and holding a password", () => {
  assert.equal(credentialsReady(FIRM), true);
  assert.equal(credentialsReady({ ...FIRM, einvoiceEnabled: false }), false);
  assert.equal(credentialsReady({ ...FIRM, einvoiceUsername: "" }), false);
  assert.equal(credentialsReady({ ...FIRM, einvoicePasswordEnc: "" }), false);
  assert.equal(credentialsReady({}), false);
  assert.equal(credentialsReady(null), false);
});

console.log(`\n${passed} checks passed.\n`);
