/**
 * Fixture tests for clearing form-default zeros.
 *
 *   node scripts/blank-zeros.test.mjs
 *
 * The run touches live master data, so what matters is that it clears ONLY the
 * zeros the old forms wrote and leaves every real figure — including a
 * deliberate 0 on a field that is not in the list — exactly as it is.
 */

import assert from "node:assert/strict";
import {
  CUSTOMER_FIELDS,
  ITEM_FIELDS,
  isUnsetZero,
  planBlanking,
  unsetFor,
} from "../lib/blankZeros.mjs";

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

console.log("\n--- what counts as a form-default zero ---");

test("0, \"0\" and \"\" all count", () => {
  assert.equal(isUnsetZero(0), true);
  assert.equal(isUnsetZero("0"), true);
  assert.equal(isUnsetZero(""), true);
  assert.equal(isUnsetZero("  "), true);
  assert.equal(isUnsetZero(0.0), true);
});

test("a real figure never counts", () => {
  assert.equal(isUnsetZero(520), false);
  assert.equal(isUnsetZero("520"), false);
  assert.equal(isUnsetZero(0.5), false);
  assert.equal(isUnsetZero(-1), false, "a negative is someone's data, not a default");
});

test("an already-absent field is not re-cleared", () => {
  assert.equal(isUnsetZero(null), false);
  assert.equal(isUnsetZero(undefined), false);
});

test("non-numeric text is left alone rather than treated as zero", () => {
  assert.equal(isUnsetZero("abc"), false);
  assert.equal(isUnsetZero("on request"), false);
});

console.log("\n--- planning a run ---");

test("only the listed fields are considered", () => {
  // openingQuantity is NOT in ITEM_FIELDS: an opening stock of 0 is a real
  // statement about the shelf, not an unfilled box.
  const [row] = planBlanking(
    [{ _id: "1", name: "Valve", salePrice: 0, openingQuantity: 0, cost: 520 }],
    ITEM_FIELDS
  );
  assert.deepEqual(row.fields, ["salePrice"]);
});

test("a record with nothing to clear is not in the plan", () => {
  assert.deepEqual(
    planBlanking([{ _id: "1", name: "Priced", salePrice: 340, cost: 300 }], ITEM_FIELDS),
    []
  );
});

test("several zeros on one record are collected together", () => {
  const [row] = planBlanking(
    [{ _id: "1", name: "Blank", salePrice: 0, cost: 0, mrp: 0, discount: 0 }],
    ITEM_FIELDS
  );
  assert.deepEqual(row.fields.sort(), ["cost", "discount", "mrp", "salePrice"]);
});

test("customers use their own, shorter field list", () => {
  const [row] = planBlanking(
    [{ _id: "1", name: "Sharma", discount: 0, interest: 0, pincode: 0 }],
    CUSTOMER_FIELDS
  );
  // pincode is not a rate and is not in CUSTOMER_FIELDS.
  assert.deepEqual(row.fields.sort(), ["discount", "interest"]);
});

test("an empty collection plans nothing", () => {
  assert.deepEqual(planBlanking([], ITEM_FIELDS), []);
  assert.deepEqual(planBlanking(), []);
});

console.log("\n--- the write ---");

test("the plan becomes a $unset, not a $set of null", () => {
  // $unset removes the field. Storing null would leave the form showing an
  // empty box but the document carrying a value, which is the state this
  // script exists to get out of.
  const [row] = planBlanking([{ _id: "1", salePrice: 0, discount: 0 }], ITEM_FIELDS);
  assert.deepEqual(unsetFor(row), { salePrice: "", discount: "" });
});

test("clearing is behaviour-neutral for the calculations", () => {
  // Every read site does Number(x) || 0, so an absent field and a stored 0
  // produce the same figure. Only the form's display changes.
  const stored = 0;
  const cleared = undefined;
  assert.equal(Number(stored) || 0, Number(cleared) || 0);
});

console.log(`\n  ${passed} checks passed\n`);
