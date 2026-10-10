/**
 * Fixture tests for the stock figure shown on the billing pages.
 *
 *   node scripts/item-stock.test.mjs
 *
 * The thing worth guarding is WHERE the figure comes from. `Item.lastQuantity`
 * looks like the stock counterpart of `Customer.lastBal`, but nothing in the
 * posting path writes it -- it is typed into the item master by hand. The
 * figure here is the one the stock report computes:
 *
 *     openingQuantity + every receipt - every issue
 *
 * so the billing page and the stock report can never disagree.
 */

import assert from "node:assert/strict";
import {
  buildStockIndex,
  stockOf,
  formatQuantity,
} from "../lib/itemStock.mjs";

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

const ITEMS = [
  { name: "Steel Rod", openingQuantity: 100, unit: "PCS", lastQuantity: 999999 },
  { name: "Copper Wire", openingQuantity: 0, unit: "KG" },
  { name: "Brass Nut", openingQuantity: 50, unit: "" },
  { name: "Never Moved", openingQuantity: 12, unit: "BOX" },
];

// As ItemLedger.aggregate groups them: _id is the item name.
const MOVES = [
  { _id: "Steel Rod", received: 40, issued: 25 },
  { _id: "Copper Wire", received: 12.5, issued: 0 },
  { _id: "Brass Nut", received: 0, issued: 65 },
];

const qty = (index, name) => stockOf(index, name)?.quantity;

console.log("\n--- stock is opening plus receipts minus issues ---");

test("an item with movements counts from its opening quantity", () => {
  // 100 + 40 - 25
  assert.equal(qty(buildStockIndex({ items: ITEMS, movements: MOVES }), "Steel Rod"), 115);
});

test("an item with no movements sits at its opening quantity", () => {
  assert.equal(qty(buildStockIndex({ items: ITEMS, movements: MOVES }), "Never Moved"), 12);
});

test("stock can go negative when more went out than ever came in", () => {
  // 50 - 65. Real, and worth showing rather than clamping to zero.
  assert.equal(qty(buildStockIndex({ items: ITEMS, movements: MOVES }), "Brass Nut"), -15);
});

test("decimal quantities survive", () => {
  assert.equal(qty(buildStockIndex({ items: ITEMS, movements: MOVES }), "Copper Wire"), 12.5);
});

test("Item.lastQuantity is never the answer", () => {
  // Steel Rod carries a lastQuantity of 999999. If that field ever leaks into
  // the figure this test is what catches it.
  const index = buildStockIndex({ items: ITEMS, movements: MOVES });
  assert.equal(qty(index, "Steel Rod"), 115);
  assert.ok(!JSON.stringify(index).includes("999999"), "lastQuantity must not reach the index");
});

test("the index agrees with how the stock report adds up", () => {
  // The report does opening + sum(movement) over the rows it holds; this sums
  // the same movements in the database. Same arithmetic, same answer.
  const rows = [
    { receiptQuantity: 40, issueQuantity: 0 },
    { receiptQuantity: 0, issueQuantity: 25 },
  ];
  const report = 100 + rows.reduce((s, r) => s + r.receiptQuantity - r.issueQuantity, 0);
  assert.equal(qty(buildStockIndex({ items: ITEMS, movements: MOVES }), "Steel Rod"), report);
});

console.log("\n--- nothing is silently dropped ---");

test("a movement for an item missing from the master still appears", () => {
  // Deleted from the master but its history remains. Counted from zero.
  const index = buildStockIndex({ items: [], movements: [{ _id: "Ghost", received: 5, issued: 2 }] });
  assert.equal(qty(index, "Ghost"), 3);
});

test("an item with no stock record at all returns null, not zero", () => {
  const index = buildStockIndex({ items: ITEMS, movements: MOVES });
  assert.equal(stockOf(index, "Not An Item"), null);
  assert.equal(stockOf(index, ""), null);
  assert.equal(stockOf(index, undefined), null);
  assert.equal(stockOf([], "Steel Rod"), null);
  assert.equal(stockOf(undefined, "Steel Rod"), null);
});

test("empty and missing inputs do not throw", () => {
  assert.deepEqual(buildStockIndex(), []);
  assert.deepEqual(buildStockIndex({}), []);
  assert.deepEqual(buildStockIndex({ items: [{}], movements: [{}] }), []);
});

test("a missing openingQuantity reads as zero, not NaN", () => {
  const index = buildStockIndex({ items: [{ name: "Bare" }], movements: [] });
  assert.equal(qty(index, "Bare"), 0);
});

console.log("\n--- matching the name the way the ledger joins it ---");

test("an exact name matches first", () => {
  const index = buildStockIndex({ items: ITEMS, movements: MOVES });
  assert.equal(stockOf(index, "Steel Rod").name, "Steel Rod");
});

test("a name differing only by case or padding still matches", () => {
  // Otherwise a plainly selected item reads as having no stock record.
  const index = buildStockIndex({ items: ITEMS, movements: MOVES });
  assert.equal(qty(index, "steel rod"), 115);
  assert.equal(qty(index, "  Steel Rod  "), 115);
  assert.equal(qty(index, "STEEL ROD"), 115);
});

test("an exact match wins over a looser one", () => {
  const index = buildStockIndex({
    items: [
      { name: "ROD", openingQuantity: 7 },
      { name: "rod", openingQuantity: 3 },
    ],
    movements: [],
  });
  assert.equal(qty(index, "rod"), 3);
  assert.equal(qty(index, "ROD"), 7);
});

test("a padded name in the master lands in the same bucket as its movements", () => {
  const index = buildStockIndex({
    items: [{ name: " Steel Rod ", openingQuantity: 100 }],
    movements: [{ _id: "Steel Rod", received: 40, issued: 0 }],
  });
  assert.equal(index.length, 1, "must not split into two items");
  assert.equal(qty(index, "Steel Rod"), 140);
});

console.log("\n--- quantities read the way a person writes them ---");

test("trailing zeros are dropped", () => {
  assert.equal(formatQuantity(240, "PCS"), "240 PCS");
  assert.equal(formatQuantity(12.5, "KG"), "12.5 KG");
  assert.equal(formatQuantity(12.0, "KG"), "12 KG");
  assert.equal(formatQuantity(12.5000, "KG"), "12.5 KG");
});

test("no unit means no trailing space", () => {
  assert.equal(formatQuantity(50, ""), "50");
  assert.equal(formatQuantity(50), "50");
  assert.equal(formatQuantity(50, "   "), "50");
});

test("float drift does not print 14 decimals", () => {
  // 0.1 + 0.2 is the classic; so is a third of a kilo.
  assert.equal(formatQuantity(0.1 + 0.2, "KG"), "0.3 KG");
  assert.equal(formatQuantity(1 / 3, "KG"), "0.333 KG");
});

test("nothing prints NaN at a customer", () => {
  assert.equal(formatQuantity(undefined, "PCS"), "0 PCS");
  assert.equal(formatQuantity(null), "0");
  assert.equal(formatQuantity("abc", "KG"), "0 KG");
});

test("a big quantity stays plain, never an exponent", () => {
  assert.equal(formatQuantity(1000000, "PCS"), "1000000 PCS");
});

console.log(`\n  ${passed} checks passed\n`);
