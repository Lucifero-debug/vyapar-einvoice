/**
 * Tests for price-list rate resolution and row cleaning.
 *
 *   node scripts/price-list.test.mjs
 */

import assert from "node:assert/strict";
import { cleanPriceListItems, resolveItemRate, priceListLabel, latestPriceListFor } from "../lib/priceList.mjs";

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

const pen = { _id: "a1", name: "Pen", salePrice: 10 };
const ink = { _id: "b2", name: "Ink", salePrice: 25 };
const wholesale = { name: "Wholesale", items: [{ itemId: "a1", price: 8 }] };

test("item master is used when no price list is chosen", () => {
  assert.equal(resolveItemRate(pen, null), 10);
});

test("price list rate wins when the item is in the list", () => {
  assert.equal(resolveItemRate(pen, wholesale), 8);
});

test("falls back to master price for items missing from the list", () => {
  assert.equal(resolveItemRate(ink, wholesale), 25);
});

test("a zero list price is honoured, not treated as missing", () => {
  assert.equal(resolveItemRate(pen, { items: [{ itemId: "a1", price: 0 }] }), 0);
});

test("blank, negative, non-numeric and duplicate rows are dropped", () => {
  const rows = cleanPriceListItems([
    { itemId: "a1", name: "Pen", price: "8" },   // old field name, still read
    { itemId: "a1", name: "Pen", price: 9 },     // duplicate — first one wins
    { itemId: "b2", name: "Ink", price: "" },    // blank, carries nothing
    { itemId: "c3", price: -1 },                 // a typo, not a price
    { itemId: "d4", price: "abc" },              // likewise
    { price: 5 },                                // no item
    { itemId: "e5", price: 0 },                  // genuinely free
  ]);
  assert.deepEqual(rows, [
    { itemId: "a1", name: "Pen", unit: "", salePrice: 8, mrp: null, discount: 0 },
    { itemId: "e5", name: undefined, unit: "", salePrice: 0, mrp: null, discount: 0 },
  ]);
});

test("a negative or non-numeric rate never becomes a free item", () => {
  // Coercing an unusable cell to 0 put the item on the list at no charge.
  const item = { _id: "x", salePrice: 500 };
  for (const bad of [-1, "abc", NaN, Infinity]) {
    const [row] = cleanPriceListItems([{ itemId: "x", salePrice: bad, discount: 10 }]);
    assert.equal(row.salePrice, null, `${bad} should read as blank, not 0`);
    assert.equal(
      resolveItemRate(item, { items: [row] }), 500,
      `${bad} should fall back to the item master rate`
    );
  }
});

test("a row whose only content was unusable is not stored at all", () => {
  assert.deepEqual(cleanPriceListItems([{ itemId: "x", salePrice: -5 }]), []);
});

test("zero is still a real price, and blank still means the master", () => {
  const item = { _id: "x", salePrice: 500 };
  assert.equal(resolveItemRate(item, { items: [{ itemId: "x", salePrice: 0 }] }), 0);
  assert.equal(resolveItemRate(item, { items: [{ itemId: "x", salePrice: null, discount: 5 }] }), 500);
});

test("label shows party and date", () => {
  assert.equal(priceListLabel({ partyName: "Sharma Traders", date: "2026-09-25" }), "Sharma Traders · 25-09-2026");
});

test("latest price list is picked per party", () => {
  const lists = [
    { _id: "1", party: "p1", date: "2026-01-01" },
    { _id: "2", party: "p1", date: "2026-06-01" },
    { _id: "3", party: "p2", date: "2026-12-01" },
  ];
  assert.equal(latestPriceListFor(lists, "p1")._id, "2");
  assert.equal(latestPriceListFor(lists, "p9"), null);
  assert.equal(latestPriceListFor(lists, undefined), null);
});

console.log(`\n${passed} passed`);
