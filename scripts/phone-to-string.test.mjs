/**
 * Fixture tests for the phone Number -> String conversion.
 *
 *   node scripts/phone-to-string.test.mjs
 *
 * The conversion runs once over live customer records, so the cases that must
 * not surprise anyone are the odd ones: a value that is already a string, a
 * blank, a zero, and the floats Mongo will hand back for a number that was
 * never a phone number in the first place.
 */

import assert from "node:assert/strict";
import { looksTruncated, phoneToString, planFieldConversion, planPhoneConversion } from "../lib/phone.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

console.log("\n--- what each stored value becomes ---");

test("a number becomes its digits", () => {
  assert.equal(phoneToString(9811122233), "9811122233");
});

test("a short number keeps exactly the digits that survived", () => {
  // A 10-digit mobile beginning 0 was stored as 9 digits. The lost zero cannot
  // be recovered, and inventing one would be worse than leaving it short.
  assert.equal(phoneToString(981112223), "981112223");
});

test("a string is left alone — the row needs no write", () => {
  assert.equal(phoneToString("+91 98111 22233"), null);
  assert.equal(phoneToString(""), null);
  assert.equal(phoneToString("09811122233"), null);
});

test("a missing phone is left alone", () => {
  assert.equal(phoneToString(null), null);
  assert.equal(phoneToString(undefined), null);
});

test("zero becomes \"0\", not blank", () => {
  // It is a real stored value; blanking it would lose what was there.
  assert.equal(phoneToString(0), "0");
});

test("no exponent notation and no decimal point ever reaches the field", () => {
  assert.equal(phoneToString(9811122233.0), "9811122233");
  assert.equal(phoneToString(1e21), "1000000000000000000000");
  assert.ok(!/[.e+]/.test(phoneToString(1e21)), "a phone must be plain digits");
});

test("NaN and Infinity blank the field rather than writing \"NaN\"", () => {
  assert.equal(phoneToString(NaN), "");
  assert.equal(phoneToString(Infinity), "");
});

test("a negative number keeps its digits without the sign", () => {
  assert.equal(phoneToString(-9811122233), "9811122233");
});

console.log("\n--- planning a run ---");

test("only the rows that need changing are planned", () => {
  const plan = planPhoneConversion([
    { _id: "1", name: "Already text", phone: "+91 98111 22233" },
    { _id: "2", name: "Stored as number", phone: 9811122233 },
    { _id: "3", name: "No phone", phone: null },
    { _id: "4", name: "Missing field" },
    { _id: "5", name: "Blank text", phone: "" },
  ]);

  assert.equal(plan.length, 1, "only the numeric row needs a write");
  assert.equal(plan[0]._id, "2");
  assert.equal(plan[0].to, "9811122233");
  assert.equal(plan[0].fromType, "number");
});

test("an empty collection plans nothing", () => {
  assert.deepEqual(planPhoneConversion([]), []);
  assert.deepEqual(planPhoneConversion(), []);
});

test("the plan records what was there, for the backup", () => {
  const [row] = planPhoneConversion([{ _id: "x", name: "Sharma", phone: 9811122233 }]);
  assert.equal(row.from, 9811122233);
  assert.equal(row.name, "Sharma");
});

test("a nine-digit number is flagged as possibly missing its leading zero", () => {
  assert.equal(looksTruncated({ from: 981112223 }), true, "nine digits — flag it");
  assert.equal(looksTruncated({ from: 9811122233 }), false, "ten digits — fine");
  assert.equal(looksTruncated({ from: "981112223" }), false, "already text — not our problem");
  assert.equal(looksTruncated({ from: NaN }), false);
});

console.log("\n--- pincode, same rule, different field ---");

test("pincode converts like phone", () => {
  const [row] = planFieldConversion([{ _id: "1", name: "Sharma", pincode: 110076 }], "pincode");
  assert.equal(row.to, "110076");
  assert.equal(row.field, "pincode");
});

test("a pincode already stored as text is skipped", () => {
  assert.deepEqual(planFieldConversion([{ _id: "1", pincode: "110076" }], "pincode"), []);
});

test("the nine-digit warning is about phones, not pincodes", () => {
  // A six-digit pincode is the right length; only a phone can have lost a
  // leading zero, so the warning must not fire for pincode rows.
  assert.equal(looksTruncated({ field: "pincode", from: 110076 }), false);
  assert.equal(looksTruncated({ field: "phone", from: 981112223 }), true);
});

test("one pass over the same records can plan both fields", () => {
  const rows = [{ _id: "1", name: "Sharma", phone: 9811122233, pincode: 110076 }];
  const plan = [
    ...planFieldConversion(rows, "phone"),
    ...planFieldConversion(rows, "pincode"),
  ];
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((r) => r.field), ["phone", "pincode"]);
});

console.log(`\n  ${passed} checks passed\n`);
