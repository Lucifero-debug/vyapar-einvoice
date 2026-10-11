/**
 * Fixture tests for the production plan and the stock column on the
 * item-wise pending report.
 *
 *   node scripts/production-plan.test.mjs
 *
 * NOT a Sigfa feature. Sigfa has no planner -- its binary holds `PlanGrid`
 * (a VB grid control), `PLANo` (a document number) and `Deposit Planning`
 * (banking), and every `MRP` string in it is Maximum Retail Price. There are
 * no PLAN, SCHED or REQ tables in its program file or in the client's data.
 * So nothing here is measured against Sigfa's behaviour; it is measured
 * against arithmetic.
 *
 * THE ONE THING THAT MATTERS: STOCK IS PROMISED ONCE.
 *
 * It is used twice over unless something stops it -- once to reduce what has
 * to be made, and again to reduce the shortfall of the same item in the
 * material list. The first draft of this module did exactly that: an item
 * owed 50 with 10 on the shelf came out as "make 40, short 30", counting the
 * ten against both, so the plan under-ordered by precisely the stock on hand.
 * It was found by a smoke run, not by a test, which is why the double-count
 * cases below are the bulk of this file.
 *
 * The other three failure modes:
 *
 *   EXPLODING THE WRONG QUANTITY. A shop owing 400 and holding 300 needs
 *   material for 100. Exploding the full 400 orders four times the steel.
 *
 *   IGNORING WHAT IS ALREADY COMING. Material on an open purchase order is
 *   incoming supply. Leaving it out tells you to buy what you have already
 *   bought, and a planner that does that once is never opened again.
 *
 *   NETTING A BY-PRODUCT AS SUPPLY. A by-product is produced by the run, not
 *   held in stock, so counting it against a shortfall nets against something
 *   that does not exist yet.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PLAN_CSV_COLUMNS,
  demandByItem,
  planFilename,
  productionPlan,
} from "../lib/productionPlan.mjs";
import {
  SIGFA_ITEM_HEADERS,
  itemPendingFrom,
  pendingLineRows,
  toCsv,
  withStock,
} from "../lib/orderReports.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";

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

/** Read a project file, for the wiring checks. Declared with the helper. */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** 1 Bracket = 2 MS Sheet + 4 Screw, and half a unit of Scrap comes back. */
const bracketBom = (over = {}) => ({
  name: "Bracket",
  outputItem: "Bracket",
  forQuantity: 1,
  lines: [
    { itemName: "MS Sheet", kind: "material", quantity: 2 },
    { itemName: "Screw", kind: "material", quantity: 4 },
    { itemName: "Scrap", kind: "byproduct", quantity: 0.5 },
  ],
  ...over,
});

const saleRow = (over = {}) => ({
  item: "Bracket",
  pending: 400,
  type: "Sale",
  orderNo: 1,
  ...over,
});

const plan = ({ stock = {}, cost = {}, ...rest } = {}) =>
  productionPlan({
    stockOf: (n) => (Object.prototype.hasOwnProperty.call(stock, n) ? stock[n] : null),
    costOf: (n) => cost[n] || 0,
    ...rest,
  });

const row = (list, item) => list.find((r) => r.item === item);

console.log("\n--- gathering the demand ---");

test("pending lines are summed by item", () => {
  const d = demandByItem([
    saleRow({ pending: 100, orderNo: 1 }),
    saleRow({ pending: 250, orderNo: 2 }),
    saleRow({ item: "Widget", pending: 50, orderNo: 3 }),
  ]);
  assert.equal(d.get("bracket").quantity, 350);
  assert.equal(d.get("bracket").orders.size, 2);
  assert.equal(d.get("bracket").lines, 2);
  assert.equal(d.get("widget").quantity, 50);
});

test("the same item in two spellings is one demand", () => {
  // Names join case-insensitively everywhere in this app, and an order typed
  // "ms sheet" is the same steel as one typed "MS Sheet".
  const d = demandByItem([saleRow({ item: "MS Sheet", pending: 10 }), saleRow({ item: "ms sheet", pending: 5 })]);
  assert.equal(d.size, 1);
  assert.equal(d.get("ms sheet").quantity, 15);
  assert.equal(d.get("ms sheet").item, "MS Sheet", "the first spelling is kept");
});

test("a nameless line is not a demand", () => {
  assert.equal(demandByItem([{ item: "", pending: 100 }]).size, 0);
  assert.equal(demandByItem([]).size, 0);
});

test("the plan reads the same rows the pending report does", () => {
  // One flattening, so the plan and the item-wise pending list cannot
  // disagree about what is owed.
  const orders = [
    {
      orderNo: 1,
      type: "Sale",
      date: new Date("2026-07-01"),
      customer: { name: "Acme" },
      items: [{ name: "Bracket", quantity: 400, invoicedQty: 0, cancelledQty: 0, cost: 100 }],
    },
  ];
  const rows = pendingLineRows(orders);
  assert.equal(demandByItem(rows).get("bracket").quantity, 400);
});

console.log("\n--- what has to be made ---");

test("stock on hand reduces what has to be made", () => {
  // The subtraction the whole plan turns on. Making all 400 would consume
  // four times the material it should.
  const p = plan({
    saleRows: [saleRow({ pending: 400 })],
    boms: [bracketBom()],
    stock: { Bracket: 300, "MS Sheet": 0, Screw: 0 },
  });
  const made = row(p.make, "Bracket");
  assert.equal(made.pending, 400);
  assert.equal(made.inStock, 300);
  assert.equal(made.fromStock, 300);
  assert.equal(made.toMake, 100);
});

test("holding more than is owed means making none, not a negative", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 100 })],
    boms: [bracketBom()],
    stock: { Bracket: 500 },
  });
  assert.equal(row(p.make, "Bracket").toMake, 0);
  assert.equal(row(p.make, "Bracket").fromStock, 100, "only what is owed is drawn");
  assert.equal(p.summary.coveredFromStock, 1);
  assert.equal(p.summary.itemsToMake, 0);
});

test("the material requirement follows what is MADE, not what is owed", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 400 })],
    boms: [bracketBom()],
    stock: { Bracket: 300, "MS Sheet": 0, Screw: 0 },
  });
  assert.equal(row(p.buy, "MS Sheet").required, 200, "2 per Bracket, for 100 Brackets");
  assert.notEqual(row(p.buy, "MS Sheet").required, 800, "that is the material for all 400");
});

test("an item nothing knows how to make is listed as bought in", () => {
  // Most of a trading firm's catalogue is. Dropping it would make the plan
  // silently ignore most of the order book.
  const p = plan({ saleRows: [saleRow({ item: "Widget", pending: 50 })], boms: [], stock: {} });
  const made = row(p.make, "Widget");
  assert.equal(made.hasFormula, false);
  assert.equal(made.formulaName, "");
  assert.ok(row(p.buy, "Widget"), "it reaches the material list");
  assert.ok(p.warnings.some((w) => /no formula/.test(w) && /Widget/.test(w)));
});

test("an item with two formulas is left out and said so", () => {
  // Picking one would make the plan depend on which the database returned
  // first -- the same quantity planned differently on different days.
  const p = plan({
    saleRows: [saleRow()],
    boms: [bracketBom(), bracketBom({ name: "Bracket (import)" })],
    stock: {},
  });
  assert.equal(row(p.make, "Bracket").ambiguous, true);
  assert.equal(row(p.buy, "Bracket"), undefined, "and it is not quietly bought instead");
  assert.ok(p.warnings.some((w) => /2 formulas/.test(w)));
  // Nor is one of the two formulas used anyway. Planning from whichever came
  // back first would make the material list depend on database order -- the
  // same quantity planned differently on different days, with nothing on the
  // sheet to say why.
  assert.deepEqual(p.buy, [], "no material may be derived from an ambiguous item");
  assert.equal(row(p.make, "Bracket").materialLines, 0);
});

console.log("\n--- stock is promised ONCE ---");

test("a bought-in item's stock is not netted twice", () => {
  // The bug that shipped in the first draft: owed 50, 10 on the shelf came
  // out as "make 40" and then "short 30" -- the ten counted against both, so
  // the plan under-ordered by exactly the stock on hand.
  const p = plan({
    saleRows: [saleRow({ item: "Widget", pending: 50 })],
    boms: [],
    stock: { Widget: 10 },
  });
  const buy = row(p.buy, "Widget");
  assert.equal(buy.required, 50, "the FULL demand goes to the material list");
  assert.equal(buy.inStock, 10, "and the stock is still there to net against");
  assert.equal(buy.short, 40);
  assert.notEqual(buy.short, 30, "30 is the stock counted twice");
});

test("a made item's stock cannot also cover its use as a component", () => {
  // Bracket is owed 400 with 300 in stock, so all 300 are promised to those
  // orders. An Assembly that also consumes Brackets must not be told there
  // are 300 sitting there.
  const assembly = {
    name: "Assembly",
    outputItem: "Assembly",
    forQuantity: 1,
    lines: [{ itemName: "Bracket", kind: "material", quantity: 1 }],
  };
  const p = plan({
    saleRows: [saleRow({ item: "Bracket", pending: 400 }), saleRow({ item: "Assembly", pending: 50, orderNo: 2 })],
    boms: [bracketBom(), assembly],
    // Not nested, so the Assembly's Bracket requirement stays a requirement
    // rather than being exploded into steel.
    nested: false,
    stock: { Bracket: 300, "MS Sheet": 0, Screw: 0 },
  });
  const buy = row(p.buy, "Bracket");
  assert.equal(buy.required, 50, "the Assembly needs 50 Brackets");
  assert.equal(buy.inStock, 0, "all 300 were promised to the Bracket orders");
  assert.equal(buy.short, 50);
  assert.notEqual(buy.short, 0, "0 is the same 300 promised to two things at once");
});

test("an item with no stock record stays unknown after the pool is touched", () => {
  // `draw` must leave an unknown item alone rather than writing a figure into
  // the pool for it. Dropping that guard turns null into 0 by arithmetic, and
  // the material list then reports "none in stock" for something that is not
  // in the master at all -- two different facts, and the second is usually a
  // name mismatch worth seeing.
  const assembly = {
    name: "Assembly",
    outputItem: "Assembly",
    forQuantity: 1,
    lines: [{ itemName: "Bracket", kind: "material", quantity: 1 }],
  };
  const p = plan({
    saleRows: [saleRow({ item: "Bracket", pending: 10 }), saleRow({ item: "Assembly", pending: 5, orderNo: 2 })],
    boms: [bracketBom(), assembly],
    nested: false,
    stock: {},
  });
  const buy = row(p.buy, "Bracket");
  assert.equal(buy.inStock, null, "null, not 0 -- it was never in the master");
  assert.equal(buy.known, false);
});

test("the pool is drawn in a defined order, so the plan is repeatable", () => {
  // Items are processed in name order. Without that, two runs over the same
  // book could allocate a scarce item differently.
  const src = read("../lib/productionPlan.mjs");
  assert.ok(/sort\(\(a, b\) => a\.item\.localeCompare\(b\.item\)\)/.test(src));
});

console.log("\n--- what is already coming ---");

test("material on an open purchase order reduces the shortfall", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 100 })],
    purchaseRows: [{ item: "MS Sheet", pending: 100, type: "Purchase", orderNo: 9 }],
    boms: [bracketBom()],
    stock: { Bracket: 0, "MS Sheet": 50, Screw: 1000 },
  });
  const buy = row(p.buy, "MS Sheet");
  assert.equal(buy.required, 200);
  assert.equal(buy.inStock, 50);
  assert.equal(buy.onOrder, 100);
  assert.equal(buy.short, 50, "200 - 50 - 100");
});

test("what is on order is its own column, not folded into stock", () => {
  // A shortfall that is surprisingly small should be visibly small for a
  // reason, rather than looking like there is more stock than there is.
  const p = plan({
    saleRows: [saleRow({ pending: 100 })],
    purchaseRows: [{ item: "MS Sheet", pending: 100, type: "Purchase", orderNo: 9 }],
    boms: [bracketBom()],
    stock: { Bracket: 0, "MS Sheet": 50, Screw: 1000 },
  });
  const buy = row(p.buy, "MS Sheet");
  assert.equal(buy.inStock, 50, "the stock figure is the stock figure");
  assert.notEqual(buy.inStock, 150);
});

test("more on order than is needed does not create a negative shortfall", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 10 })],
    purchaseRows: [{ item: "MS Sheet", pending: 99999, type: "Purchase", orderNo: 9 }],
    boms: [bracketBom()],
    stock: { Bracket: 0, "MS Sheet": 0, Screw: 0 },
  });
  assert.equal(row(p.buy, "MS Sheet").short, 0);
});

test("a purchase order for something nothing needs is simply ignored", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 10 })],
    purchaseRows: [{ item: "Unrelated", pending: 500, type: "Purchase", orderNo: 9 }],
    boms: [bracketBom()],
    stock: {},
  });
  assert.equal(row(p.buy, "Unrelated"), undefined);
});

console.log("\n--- by-products ---");

test("a by-product is not a requirement", () => {
  // It is produced by the run, not consumed by it.
  const p = plan({ saleRows: [saleRow({ pending: 10 })], boms: [bracketBom()], stock: {} });
  assert.equal(row(p.buy, "Scrap"), undefined);
  assert.ok(row(p.buy, "MS Sheet"), "but the materials are");
});

test("a by-product is not counted as supply either", () => {
  // Netting a shortfall against something the run has not produced yet would
  // under-order it. Scrap is demanded by a customer here AND produced by the
  // Bracket run; only the demand may count.
  const p = plan({
    saleRows: [saleRow({ pending: 10 }), saleRow({ item: "Scrap", pending: 100, orderNo: 2 })],
    boms: [bracketBom()],
    stock: { Scrap: 0 },
  });
  assert.equal(row(p.buy, "Scrap").required, 100);
  assert.equal(row(p.buy, "Scrap").short, 100, "the 5 the run would make do not cover it");
});

console.log("\n--- nesting ---");

test("a sub-formula is broken down to raw material", () => {
  const plateBom = {
    name: "Plate",
    outputItem: "Plate",
    forQuantity: 10,
    lines: [{ itemName: "Strip", kind: "material", quantity: 25 }],
  };
  const widgetBom = {
    name: "Widget",
    outputItem: "Widget",
    forQuantity: 1,
    lines: [{ itemName: "Plate", kind: "material", quantity: 2 }],
  };
  const p = plan({
    saleRows: [saleRow({ item: "Widget", pending: 5 })],
    boms: [widgetBom, plateBom],
    stock: {},
  });
  // 5 Widgets = 10 Plates = one batch of 10 = 25 Strip.
  assert.equal(row(p.buy, "Strip").required, 25);
  assert.equal(row(p.buy, "Plate"), undefined, "the sub-assembly is not a purchase");
});

test("nesting off leaves the sub-assembly as the thing to buy", () => {
  const plateBom = {
    name: "Plate",
    outputItem: "Plate",
    forQuantity: 10,
    lines: [{ itemName: "Strip", kind: "material", quantity: 25 }],
  };
  const widgetBom = {
    name: "Widget",
    outputItem: "Widget",
    forQuantity: 1,
    lines: [{ itemName: "Plate", kind: "material", quantity: 2 }],
  };
  const p = plan({
    saleRows: [saleRow({ item: "Widget", pending: 5 })],
    boms: [widgetBom, plateBom],
    nested: false,
    stock: {},
  });
  assert.equal(row(p.buy, "Plate").required, 10);
  assert.equal(row(p.buy, "Strip"), undefined);
});

test("a loop between formulas is reported, not followed", () => {
  const a = { name: "A", outputItem: "A", forQuantity: 1, lines: [{ itemName: "B", kind: "material", quantity: 1 }] };
  const b = { name: "B", outputItem: "B", forQuantity: 1, lines: [{ itemName: "A", kind: "material", quantity: 1 }] };
  const p = plan({ saleRows: [saleRow({ item: "A", pending: 1 })], boms: [a, b], stock: {} });
  assert.ok(p.warnings.some((w) => /loops back on itself/.test(w)));
});

console.log("\n--- the material list ---");

test("one material needed by two products is summed once", () => {
  const other = {
    name: "Clamp",
    outputItem: "Clamp",
    forQuantity: 1,
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: 3 }],
  };
  const p = plan({
    saleRows: [saleRow({ pending: 10 }), saleRow({ item: "Clamp", pending: 10, orderNo: 2 })],
    boms: [bracketBom(), other],
    stock: { "MS Sheet": 0 },
  });
  const buy = row(p.buy, "MS Sheet");
  assert.equal(buy.required, 50, "20 for the Brackets, 30 for the Clamps");
  assert.deepEqual(buy.forItems, ["Bracket", "Clamp"], "and it says which drove it");
});

test("the shortfall is valued at the item master's cost", () => {
  // Some stock on hand on purpose, so `required` and `short` are DIFFERENT
  // numbers. With none, the two are equal and a valuation that used the
  // requirement would look right -- which is exactly how the first version of
  // this test passed while the figure could have been wrong.
  const p = plan({
    saleRows: [saleRow({ pending: 10 })],
    boms: [bracketBom()],
    stock: { "MS Sheet": 5, Screw: 0 },
    cost: { "MS Sheet": 40 },
  });
  const buy = row(p.buy, "MS Sheet");
  assert.equal(buy.required, 20);
  assert.equal(buy.short, 15, "20 needed, 5 on the shelf");
  assert.equal(buy.rate, 40);
  assert.equal(buy.value, 600, "what it costs to buy the shortfall");
  assert.notEqual(buy.value, 800, "800 values the whole requirement");
});

test("a material not in the item master is named and valued at nothing", () => {
  const p = plan({ saleRows: [saleRow({ pending: 10 })], boms: [bracketBom()], stock: {} });
  const buy = row(p.buy, "MS Sheet");
  assert.equal(buy.known, false);
  assert.equal(buy.inStock, null, "null, not 0 -- they are different facts");
  assert.equal(buy.value, 0);
  assert.ok(p.warnings.some((w) => /not in the item master/.test(w)));
});

test("the list is ordered by what is most short", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 10 })],
    boms: [bracketBom()],
    stock: { "MS Sheet": 0, Screw: 0 },
  });
  // 40 Screws against 20 MS Sheet.
  assert.deepEqual(p.buy.map((b) => b.item), ["Screw", "MS Sheet"]);
});

test("a covered material still appears, at zero short", () => {
  // Worth seeing: it is the evidence that the plan considered it.
  const p = plan({
    saleRows: [saleRow({ pending: 10 })],
    boms: [bracketBom()],
    stock: { "MS Sheet": 99999, Screw: 99999 },
  });
  assert.equal(row(p.buy, "MS Sheet").short, 0);
  assert.equal(p.summary.materials, 2);
  assert.equal(p.summary.shortMaterials, 0);
});

console.log("\n--- the summary ---");

test("the figures describe the lists beneath them", () => {
  const p = plan({
    saleRows: [saleRow({ pending: 400 }), saleRow({ item: "Widget", pending: 50, orderNo: 2 })],
    purchaseRows: [{ item: "MS Sheet", pending: 100, type: "Purchase", orderNo: 9 }],
    boms: [bracketBom()],
    stock: { Bracket: 300, "MS Sheet": 50, Screw: 1000, Widget: 10 },
    cost: { "MS Sheet": 40, Widget: 250 },
  });
  assert.equal(p.summary.itemsOnOrder, p.make.length);
  assert.equal(p.summary.materials, p.buy.length);
  assert.equal(p.summary.shortMaterials, p.buy.filter((b) => b.short > 0).length);
  assert.equal(
    p.summary.shortValue,
    Math.round(p.buy.reduce((t, b) => t + b.value, 0) * 100) / 100
  );
});

test("an empty order book plans nothing, and does not throw", () => {
  const p = plan({ saleRows: [], boms: [bracketBom()], stock: {} });
  assert.deepEqual(p.make, []);
  assert.deepEqual(p.buy, []);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.summary.shortValue, 0);
});

test("the plan survives being given nothing at all", () => {
  const p = productionPlan();
  assert.deepEqual(p.make, []);
  assert.deepEqual(p.buy, []);
});

console.log("\n--- downloads ---");

test("both column sets exist and name their keys", () => {
  for (const set of ["make", "buy"]) {
    assert.ok(Array.isArray(PLAN_CSV_COLUMNS[set]));
    for (const col of PLAN_CSV_COLUMNS[set]) {
      assert.equal(typeof col.key, "string");
      assert.equal(typeof col.label, "string");
    }
  }
});

test("an item missing from the master exports as words, not as a blank", () => {
  const csv = toCsv(PLAN_CSV_COLUMNS.buy, [
    { item: "Ghost", required: 10, inStock: null, known: false, onOrder: 0, short: 10, rate: 0, value: 0, forItems: [] },
  ]);
  assert.ok(csv.includes("not in master"));
});

test("an item with nothing on the shelf exports as 0, not as missing", () => {
  // `??` rather than `||` in the column: 0 is falsy and would otherwise come
  // out as "not in master", which is a different fact.
  const csv = toCsv(PLAN_CSV_COLUMNS.buy, [
    { item: "Steel", required: 10, inStock: 0, known: true, onOrder: 0, short: 10, rate: 0, value: 0, forItems: [] },
  ]);
  assert.equal(csv.includes("not in master"), false);
});

test("the file name says which list and when", () => {
  assert.equal(planFilename("buy", Date.parse("2026-10-11")), "production-plan-materials-2026-10-11.csv");
  assert.equal(planFilename("make", Date.parse("2026-10-11")), "production-plan-to-make-2026-10-11.csv");
});

console.log("\n--- stock on the item-wise pending report ---");

const pendingGroups = () =>
  itemPendingFrom([
    { item: "MS Sheet", pending: 400, type: "Sale", orderNo: 1, value: 16000, overdueDays: 0 },
    { item: "Bracket", pending: 100, type: "Sale", orderNo: 2, value: 10000, overdueDays: 0 },
    { item: "Ghost", pending: 50, type: "Sale", orderNo: 3, value: 500, overdueDays: 0 },
  ]);

test("the stock sits beside the pending quantity", () => {
  const stock = { "MS Sheet": 150, Bracket: 250 };
  const rows = withStock(pendingGroups(), (n) => (n in stock ? stock[n] : null));
  const sheet = row(rows, "MS Sheet");
  assert.equal(sheet.pendingQty, 400);
  assert.equal(sheet.stock, 150);
  assert.equal(sheet.shortBy, 250);
  assert.equal(sheet.covered, false);
});

test("holding more than is owed is a surplus, not a negative shortfall", () => {
  // "-150 short" reads as the opposite of what it means on a list people scan.
  const rows = withStock(pendingGroups(), () => 250);
  const bracket = row(rows, "Bracket");
  assert.equal(bracket.shortBy, 0);
  assert.equal(bracket.surplus, 150);
  assert.equal(bracket.covered, true);
});

test("not in the master is a different fact from none left", () => {
  const stock = { "MS Sheet": 0 };
  const rows = withStock(pendingGroups(), (n) => (n in stock ? stock[n] : null));
  assert.equal(row(rows, "MS Sheet").stock, 0);
  assert.equal(row(rows, "MS Sheet").known, true);
  assert.equal(row(rows, "Ghost").stock, null);
  assert.equal(row(rows, "Ghost").known, false);
  assert.equal(row(rows, "Ghost").shortBy, 50, "an unknown item is short by the whole quantity");
});

test("the merge keeps everything the group already carried", () => {
  const rows = withStock(pendingGroups(), () => 0);
  assert.equal(row(rows, "MS Sheet").pendingValue, 16000);
  assert.ok(Array.isArray(row(rows, "MS Sheet").lines));
});

test("no stock source at all leaves every item unknown", () => {
  const rows = withStock(pendingGroups());
  for (const r of rows) {
    assert.equal(r.known, false);
    assert.equal(r.shortBy, r.pendingQty);
  }
});

console.log("\n--- wiring ---");

test("the planner is read-only", () => {
  // It writes nothing and creates nothing: a plan is a derived figure, and a
  // derived figure that writes documents is one wrong formula away from a
  // real purchase order.
  const src = read("../app/api/production-plan/route.js");
  for (const write of [".create(", ".updateOne(", ".insertMany(", ".save(", ".deleteMany(", "findOneAndUpdate"]) {
    assert.equal(src.includes(write), false, `the planner writes: ${write}`);
  }
  assert.equal(/export const POST/.test(src), false, "and offers no write endpoint");
  assert.ok(/export const GET/.test(src));
});

test("the planner does no arithmetic of its own", () => {
  const src = read("../app/api/production-plan/route.js");
  assert.ok(/productionPlan\(/.test(src));
  assert.equal(/\.pending\s*-\s*/.test(src), false, "the route is netting figures itself");
});

test("it reads the same pending rows the reports do", () => {
  assert.ok(/pendingLineRows/.test(read("../app/api/production-plan/route.js")));
});

test("incoming purchase orders are not narrowed by the customer being planned for", () => {
  // Material already on order is incoming supply whoever it was bought from.
  // Filtering it by party would double-count every shortfall.
  const src = read("../app/api/production-plan/route.js");
  assert.ok(/customer\.name/.test(src), "the sale query does filter by party");
  assert.equal(
    /type: "Purchase"[^}]*customer/s.test(src),
    false,
    "but the purchase query must not"
  );
});

test("held formulas are kept out of the plan", () => {
  // A formula on hold is kept out of the production picker; planning against
  // it would promise materials for a recipe nobody may use.
  assert.ok(/hold: \{ \$ne: true \}/.test(read("../app/api/production-plan/route.js")));
});

test("the rules module stays free of Mongoose", () => {
  const src = read("../lib/productionPlan.mjs");
  assert.equal(/from ["']mongoose["']/.test(src), false);
  assert.equal(/\.\.\/models\//.test(src), false);
});

test("the item-pending route fetches stock only for that view", () => {
  // The register and the party-wise list have no use for it, and loading the
  // item master for them would be paid on every report and used on one.
  const src = read("../app/api/order-report/route.js");
  assert.ok(/case "item-pending": \{/.test(src), "it must be inside that case");
  assert.ok(/withStock\(/.test(src));
  assert.ok(/buildStockIndex/.test(src), "and through the shared stock rule");
});

test("the report page's colSpans follow the view", () => {
  // A colSpan left as a constant does not throw -- it leaves a row short and
  // the grid drifts out of line.
  //
  // The NUMBER is derived from the header list rather than written here. It
  // was hard-coded as 11 when the item view carried the party columns plus
  // stock and shortfall; the view now carries Sigfa's five headings plus
  // CURRENT STOCK, and a test pinning the old figure failed for the wrong
  // reason -- the count had changed, not the rule.
  const src = read("../app/order-report/page.js");
  const itemColumns = SIGFA_ITEM_HEADERS.length + 1;
  assert.ok(/isItemView/.test(src));
  assert.ok(
    new RegExp(`colSpan=\\{isItemView \\? ${itemColumns} : 9\\}`).test(src),
    `the item view has ${itemColumns} columns, so its colSpan must say so`
  );
  assert.equal(
    (src.match(/colSpan=\{9\}/g) || []).length,
    0,
    "a hard-coded 9 is left over"
  );
});

test("the planner is filed with the order reports", () => {
  assert.equal(permissionForPath("/api/production-plan"), "invoice:read");
  assert.equal(permissionForPath("/production-plan"), "invoice:read");
  assert.equal(canAccessPath("accountant", "/production-plan"), true);
  // Read-only, so it needs no write permission even though it talks about
  // purchase orders -- and a biller who can see the order book can see this.
  assert.equal(canAccessPath("biller", "/api/production-plan"), true);
});

test("the dashboard reaches the plan", () => {
  assert.ok(/router\.push\(['"]\/production-plan['"]\)/.test(read("../app/page.js")));
});

test("the page does no arithmetic of its own", () => {
  const src = read("../app/production-plan/page.js");
  assert.equal(/productionPlan\(/.test(src), false);
  assert.ok(/loadedFor/.test(src), "and it guards against drawing stale figures");
});

console.log(`\n${passed} checks passed`);
