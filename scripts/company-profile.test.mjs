/**
 * Fixture tests for the firm's own details.
 *
 *   node scripts/company-profile.test.mjs
 *
 * What is at stake here is what gets printed on a tax invoice. The old code
 * printed a GSTIN somebody had invented, on every bill, and the firm's name
 * disagreed between the invoice and the ledger. So:
 *
 *   1. A blank detail is never printed as "undefined", and never as a
 *      plausible-looking placeholder. Blank prints as nothing.
 *   2. A value that is present and malformed is refused at the point it is
 *      typed, because by the time it is on a buyer's bill it is too late.
 *   3. The address is laid out in exactly one place, so the invoice, the
 *      ledger and the stock report cannot disagree again.
 *   4. Only the known fields reach a document, so a credential column added
 *      to `companies` later cannot be printed by accident.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BLANK_COMPANY,
  FIELD_NAMES,
  PROFILE_FIELDS,
  addressLines,
  canReportToIrp,
  companyAddress,
  companyFrom,
  has,
  irpMissing,
  profileIsValid,
  profileProblems,
} from "../lib/company.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    // An async test body would report "ok" before it had asserted anything:
    // the throw lands in a promise nobody waits for. Refuse one outright.
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/** A firm with everything filled in correctly. */
const FULL = {
  name: "Suryavansh Textiles",
  gstin: "07ABCDE1234F1Z5",
  phone: "+91 98111 22233",
  email: "billing@suryavansh.in",
  address: "LIG Flats No. 68, Third Floor, Sarita Vihar",
  city: "New Delhi",
  state: "Delhi",
  stateCode: "07",
  pincode: "110076",
  bankName: "State Bank of India",
  bankAccount: "33445566778",
  bankIfsc: "SBIN0001234",
};

console.log("\n--- nothing false reaches a document ---");

test("a firm with nothing filled in has every field blank, not undefined", () => {
  const c = companyFrom({ name: "New Firm" });
  for (const name of FIELD_NAMES) assert.equal(typeof c[name], "string", name);
  assert.equal(c.gstin, "");
  assert.ok(!JSON.stringify(c).includes("undefined"));
});

test("null, undefined and a string all survive being passed in", () => {
  for (const input of [null, undefined, "", 0, []]) {
    const c = companyFrom(input);
    assert.equal(c.name, "");
    // NO LOGO, not the shared /logo.jpg this used to assert. That constant
    // was one file in /public printed at the top of every firm's invoice;
    // see the note where it used to be declared in lib/company.mjs, and
    // scripts/company-branding.test.mjs for what replaced it.
    assert.equal(c.logo, "");
  }
});

test("only the known fields come through", () => {
  const c = companyFrom({
    ...FULL,
    einvoicePasswordEnc: "secret",
    _id: "abc",
    tokenVersion: 3,
  });
  // The profile fields, the logo, and the document preferences. `logo` and
  // `invoicePrefs` are NOT in FIELD_NAMES, which is the form's text fields
  // and doubles as the update allowlist -- each has its own normaliser
  // (lib/companyLogo.mjs, lib/invoicePrefs.mjs) and its own route.
  assert.deepEqual(Object.keys(c).sort(), [...FIELD_NAMES, "logo", "invoicePrefs"].sort());
  assert.ok(!JSON.stringify(c).includes("secret"));
});

test("a preference the module does not know cannot ride in on the record", () => {
  // The same guard as the fields above, one level down: `prefsFrom` returns
  // its own declared keys and nothing the row carried beside them.
  const c = companyFrom({ ...FULL, invoicePrefs: { gstRate: 99, showLogo: false } });
  assert.equal("gstRate" in c.invoicePrefs, false);
  assert.equal(c.invoicePrefs.showLogo, false, "and a real one is respected");
});

test("there is no hardcoded firm left anywhere in the module", () => {
  // The two names that used to be compiled into the app. If either comes back
  // as a value rather than as a placeholder, every tenant prints it again.
  const src = fs.readFileSync(new URL("../lib/company.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Prashant Enterprise/);
  assert.doesNotMatch(code, /12ABCDE3456F7Z8/, "the invented GSTIN is back");
  // The sample GSTIN on the form is a placeholder attribute, not a value.
  for (const field of PROFILE_FIELDS) {
    if (field.placeholder) assert.ok(typeof field.placeholder === "string");
  }
  assert.equal(BLANK_COMPANY.name, "");
  assert.equal(BLANK_COMPANY.gstin, "");
});

test("blank is blank, whitespace included", () => {
  assert.equal(has(""), false);
  assert.equal(has("   "), false);
  assert.equal(has(null), false);
  assert.equal(has(undefined), false);
  assert.equal(has(0), false);
  assert.equal(has("Delhi"), true);
  assert.equal(companyFrom({ city: "  New Delhi  " }).city, "New Delhi");
});

console.log("\n--- the address is laid out in one place ---");

test("a full address is two lines", () => {
  assert.deepEqual(addressLines(FULL), [
    "LIG Flats No. 68, Third Floor, Sarita Vihar",
    "New Delhi, Delhi - 110076",
  ]);
  assert.equal(
    companyAddress(FULL),
    "LIG Flats No. 68, Third Floor, Sarita Vihar, New Delhi, Delhi - 110076"
  );
});

test("missing parts leave no stray commas or dashes", () => {
  assert.deepEqual(addressLines({ city: "New Delhi" }), ["New Delhi"]);
  assert.deepEqual(addressLines({ address: "LIG 68" }), ["LIG 68"]);
  assert.deepEqual(addressLines({ city: "New Delhi", pincode: "110076" }), ["New Delhi - 110076"]);
  assert.deepEqual(addressLines({ state: "Delhi", pincode: "110076" }), ["Delhi - 110076"]);
  assert.deepEqual(addressLines({}), []);
  assert.equal(companyAddress({}), "");
  for (const company of [{}, { city: "X" }, { pincode: "110076" }, FULL]) {
    const line = companyAddress(company);
    assert.doesNotMatch(line, /^,|,,|, -|- *$|^ *-/, `"${line}"`);
  }
});

console.log("\n--- a value that is present and wrong is refused ---");

test("a correct profile has no problems", () => {
  assert.deepEqual(profileProblems(FULL), []);
  assert.equal(profileIsValid(FULL), true);
});

test("the name is the only thing actually required", () => {
  assert.deepEqual(profileProblems({ name: "Just A Name" }), []);
  assert.deepEqual(
    profileProblems({}).map((p) => p.field),
    ["name"]
  );
  assert.deepEqual(
    profileProblems({ name: "   " }).map((p) => p.field),
    ["name"]
  );
});

test("a GSTIN must be fifteen characters of the right shape", () => {
  const bad = {
    "07ABCDE1234F1Z": "too short",
    "07ABCDE1234F1Z55": "too long",
    "7ABCDE1234F1Z5A": "one leading digit",
    "07ABCD01234F1Z5": "a digit inside the PAN letters",
    "ABCDE1234F1Z567": "no state digits",
  };
  for (const [gstin, why] of Object.entries(bad)) {
    const problems = profileProblems({ name: "A", gstin, stateCode: "07" });
    assert.ok(
      problems.some((p) => p.field === "gstin"),
      `${gstin} (${why}) should be refused`
    );
  }
});

test("a lower-case GSTIN is accepted and stored upper-case", () => {
  assert.deepEqual(profileProblems({ name: "A", gstin: "07abcde1234f1z5", stateCode: "07" }), []);
  assert.equal(companyFrom({ gstin: "07abcde1234f1z5" }).gstin, "07ABCDE1234F1Z5");
  assert.equal(companyFrom({ bankIfsc: "sbin0001234" }).bankIfsc, "SBIN0001234");
});

test("the state code has to agree with the GSTIN", () => {
  // This is the one the IRP rejects with a bare error code, so it is worth
  // catching on the form.
  const problems = profileProblems({ name: "A", gstin: "07ABCDE1234F1Z5", stateCode: "09" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, "stateCode");
  assert.match(problems[0].message, /must be 07/);
});

test("a GSTIN with no state code asks for the right one", () => {
  const problems = profileProblems({ name: "A", gstin: "07ABCDE1234F1Z5" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, "stateCode");
  assert.match(problems[0].message, /07/);
});

test("'7' is a state code; 'ab' and '00' are not", () => {
  assert.deepEqual(profileProblems({ name: "A", gstin: "07ABCDE1234F1Z5", stateCode: "7" }), []);
  for (const stateCode of ["ab", "00", "-"]) {
    const problems = profileProblems({ name: "A", stateCode });
    assert.deepEqual(problems.map((p) => p.field), ["stateCode"], stateCode);
    assert.equal(problems.length, 1, `${stateCode} should produce one message, not two`);
  }
});

test("an unreadable state code with a GSTIN still gets one message", () => {
  const problems = profileProblems({ name: "A", gstin: "07ABCDE1234F1Z5", stateCode: "ab" });
  assert.deepEqual(problems.map((p) => p.field), ["stateCode"]);
  assert.equal(problems.length, 1);
});

test("PIN code, email, phone and IFSC are checked only when filled in", () => {
  assert.deepEqual(profileProblems({ name: "A", pincode: "", email: "", phone: "", bankIfsc: "" }), []);
  const cases = [
    [{ pincode: "11007" }, "pincode"],
    [{ pincode: "0110076" }, "pincode"],
    [{ pincode: "011007" }, "pincode"],
    [{ email: "billing.suryavansh.in" }, "email"],
    [{ phone: "9811" }, "phone"],
    [{ bankIfsc: "SBIN1001234" }, "bankIfsc"],
    [{ bankIfsc: "SBIN000123" }, "bankIfsc"],
  ];
  for (const [over, field] of cases) {
    assert.deepEqual(
      profileProblems({ name: "A", ...over }).map((p) => p.field),
      [field],
      JSON.stringify(over)
    );
  }
});

test("a phone number written with spaces and +91 is fine", () => {
  assert.deepEqual(profileProblems({ name: "A", phone: "+91 98111 22233" }), []);
  assert.deepEqual(profileProblems({ name: "A", phone: "011-2634 5678" }), []);
});

console.log("\n--- e-invoice readiness is stated, not guessed ---");

test("a complete profile can report to the IRP", () => {
  assert.deepEqual(irpMissing(FULL), []);
  assert.equal(canReportToIrp(FULL), true);
});

test("every missing mandatory detail is named", () => {
  assert.deepEqual(irpMissing({ name: "A" }), ["GSTIN", "Address", "City", "State code", "PIN code"]);
  assert.deepEqual(irpMissing({ ...FULL, pincode: "" }), ["PIN code"]);
  assert.equal(canReportToIrp({ ...FULL, pincode: "" }), false);
});

test("the optional details are not demanded by the IRP check", () => {
  // A firm with no bank account or email can still file an e-invoice.
  const lean = { ...FULL, bankName: "", bankAccount: "", bankIfsc: "", email: "", phone: "", state: "" };
  assert.deepEqual(irpMissing(lean), []);
  assert.equal(canReportToIrp(lean), true);
});

test("a profile that is complete but wrong cannot report", () => {
  // Filled in, so irpMissing() is happy; the state code contradicts the
  // GSTIN, so the IRP would reject it.
  const wrong = { ...FULL, stateCode: "09" };
  assert.deepEqual(irpMissing(wrong), []);
  assert.equal(canReportToIrp(wrong), false);
});

test("the fields the form shows and the fields that are stored are the same list", () => {
  assert.deepEqual(PROFILE_FIELDS.map((f) => f.name), FIELD_NAMES);
  assert.equal(new Set(FIELD_NAMES).size, FIELD_NAMES.length, "a field is listed twice");
  for (const field of PROFILE_FIELDS) {
    assert.ok(field.label, `${field.name} has no label`);
  }
  assert.ok(PROFILE_FIELDS.some((f) => f.required), "nothing is required");
  assert.equal(PROFILE_FIELDS.filter((f) => f.irp).length, 5);
});

console.log(`\n${passed} checks passed.\n`);
