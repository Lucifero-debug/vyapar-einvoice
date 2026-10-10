/**
 * Fixture tests for the zero-unit cleanup.
 *
 *   node scripts/clear-zero-units.test.mjs
 *
 * The one thing that matters: only a unit that is exactly zero is touched.
 * "10", "0.5" or a real unit like "PCS" must never be caught.
 */

import assert from "node:assert/strict";
import { isZeroUnit, planCleanup } from "./clear-zero-units.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    throw err;
  }
};

test("zero in any stored form is a zero unit", () => {
  for (const u of ["0", " 0 ", 0]) assert.equal(isZeroUnit(u), true, String(u));
});

test("real units, blanks and other numbers are left alone", () => {
  for (const u of ["PCS", "KG", "", null, undefined, "10", "0.5", "00x"])
    assert.equal(isZeroUnit(u), false, String(u));
});

test("plans only the items and price list rows with a zero unit", () => {
  const { itemPlan, priceListPlan } = planCleanup({
    allItems: [
      { _id: "a", name: "Soap", unit: "0" },
      { _id: "b", name: "Rice", unit: "KG" },
      { _id: "c", name: "Oil" },
    ],
    allPriceLists: [
      {
        _id: "p1",
        partyName: "Sharma Traders",
        items: [
          { name: "Soap", unit: "0" },
          { name: "Rice", unit: "KG" },
          { name: "Dal", unit: 0 },
        ],
      },
      { _id: "p2", items: [{ name: "Rice", unit: "KG" }] },
    ],
  });

  assert.deepEqual(itemPlan.map((i) => i._id), ["a"]);
  assert.equal(priceListPlan.length, 1);
  assert.equal(priceListPlan[0].party, "Sharma Traders");
  assert.deepEqual(priceListPlan[0].rows.map((r) => r.index), [0, 2]);
});

console.log(`\n${passed} passed\n`);
