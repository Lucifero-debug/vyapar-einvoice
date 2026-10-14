/**
 * Fixture tests for the stock reports.
 *
 *   node scripts/inventory.test.mjs
 *
 * The thing worth guarding here is not the arithmetic -- it is that this
 * module has NO OPINIONS of its own about figures something else already
 * owns. Four of them:
 *
 *   1. THE CLOSING QUANTITY IS lib/itemStock.mjs's. A window that reaches
 *      today must foot to `buildStockIndex`, or the stock sheet and the
 *      billing screen's stock line disagree about the same item.
 *   2. WHAT COUNTS AS LOW IS lib/dashboard.mjs's. The Short List calls
 *      `lowStockRows`, so the dashboard tile and the printed sheet cannot
 *      drift apart.
 *   3. THE WEIGHTED RATE IS lib/salesReports.mjs's. Its item-wise `rate` is
 *      already taxable-value over quantity across the purchase bills.
 *   4. VALUED AT COST, THIS SHEET IS THE BALANCE SHEET'S CLOSING STOCK.
 *      lib/financials.mjs's `stockValue` is the figure the balance sheet
 *      carries, and the two must be the same number.
 *
 * And one thing about the feature: FIFO and LIFO *valuation* are refused,
 * with the reason, because `ItemLedger` has no rate column. FIFO *ageing* is
 * done properly, because that needs only quantities and dates.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_AGING_SLABS,
  DEFAULT_BASIS,
  DEFAULT_FILTER,
  DAY_BOOK_COLUMNS,
  FILTER_LABELS,
  PHYSICAL_COLUMNS,
  SHORT_COLUMNS,
  STOCK_COLUMNS,
  STOCK_FILTERS,
  STOCK_REPORTS,
  STOCK_REPORT_KEYS,
  SUPPORTED_BASES,
  VALUATION_BASES,
  agingColumns,
  agingLayers,
  agingOf,
  agingTotals,
  applyFilter,
  basisOf,
  basisProblem,
  compareCount,
  countTotals,
  dayBook,
  dayBookTotals,
  headings,
  isStockFilter,
  isStockReport,
  lastPurchaseRates,
  levelOf,
  levelProblem,
  levelsOf,
  rateFor,
  reportTakesPeriod,
  round3,
  sheetTotals,
  shortList,
  shortListSummary,
  slabIndexOf,
  slabLabels,
  slabProblem,
  stockMeta,
  stockPeriod,
  stockPeriodTotals,
  stockReportName,
  stockSheets,
  valueColumns,
  valueCoverage,
  valueRows,
  voucherTypeOf,
  weightedRates,
} from "../lib/inventory.mjs";
import { buildStockIndex } from "../lib/itemStock.mjs";
import { DASHBOARD_REASONS, STOCK_REASONS, lowStockRows } from "../lib/dashboard.mjs";
import { itemWise } from "../lib/salesReports.mjs";
import { stockValue } from "../lib/financials.mjs";
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

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ───────────────────────────── fixtures ──────────────────────────────── */

const ITEMS = [
  {
    _id: "i1",
    name: "MS Plate 10mm",
    unit: "KGS",
    hsn: "7208",
    group: "Plates",
    openingQuantity: 100,
    cost: 55,
    purchasePrice: 58,
    mrp: 70,
    minQuantity: 25,
    reorderLevel: 60,
    maxLevel: 5000,
  },
  { _id: "i2", name: "Washer 12mm", unit: "NOS", openingQuantity: 0, cost: 2, minQuantity: 500 },
  // No cost, no levels: the item that shows what a gap looks like.
  { _id: "i3", name: "Scrap", unit: "KGS", openingQuantity: 40 },
];

// Deliberately NOT in date order, so anything that depends on the input order
// is caught.
const ROWS = [
  { _id: "r3", itemName: "MS Plate 10mm", date: "2026-09-20", invoiceNo: "GR-3", typeOfVoucher: "Production", partyName: "Job worker", receiptQuantity: 40, issueQuantity: 0 },
  { _id: "r1", itemName: "MS Plate 10mm", date: "2026-04-10", invoiceNo: "11", typeOfVoucher: "Purchase", partyName: "Bharat Steel", receiptQuantity: 200, issueQuantity: 0 },
  { _id: "r2", itemName: "MS Plate 10mm", date: "2026-07-01", invoiceNo: "12", typeOfVoucher: "Sale", partyName: "Acme Traders", receiptQuantity: 0, issueQuantity: 250 },
  { _id: "r4", itemName: "Washer 12mm", date: "2026-07-05", invoiceNo: "13", typeOfVoucher: "Sale", partyName: "Acme Traders", receiptQuantity: 0, issueQuantity: 80 },
  // An item the master no longer has.
  { _id: "r5", itemName: "Ghost Rod", date: "2026-08-01", invoiceNo: "14", typeOfVoucher: "Purchase", partyName: "Someone", receiptQuantity: 12, issueQuantity: 0 },
];

const MOVEMENTS = ROWS.map((r) => ({
  itemName: r.itemName,
  received: r.receiptQuantity,
  issued: r.issueQuantity,
}));

const INVOICES = [
  {
    type: "Purchase", return: false, date: "2026-04-10", invoiceNo: 11, finalAmount: 12272,
    items: [{ name: "MS Plate 10mm", quantity: 200, cost: 52, taxableAmount: 10400, gstAmount: 1872, total: 12272 }],
  },
  {
    type: "Purchase", return: false, date: "2026-08-02", invoiceNo: 21, finalAmount: 3540,
    items: [{ name: "MS Plate 10mm", quantity: 50, cost: 60, taxableAmount: 3000, gstAmount: 540, total: 3540 }],
  },
  // A purchase RETURN: it nets off the weighted average and must not be the
  // "last purchase rate".
  {
    type: "Purchase", return: true, date: "2026-09-01", invoiceNo: 22, finalAmount: 1180,
    items: [{ name: "MS Plate 10mm", quantity: 10, cost: 999, taxableAmount: 1000, gstAmount: 180, total: 1180 }],
  },
  // A SALE, whose rate is not a cost at any price.
  {
    type: "Sale", return: false, date: "2026-09-10", invoiceNo: 5, finalAmount: 9000,
    items: [{ name: "MS Plate 10mm", quantity: 100, cost: 90, taxableAmount: 9000, gstAmount: 1620, total: 10620 }],
  },
];

console.log("\n--- the figure is the ledger's ---");

test("A WINDOW THAT REACHES TODAY FOOTS TO buildStockIndex", () => {
  // If these two ever disagree, the stock sheet and the stock line under an
  // invoice item are two different answers to one question.
  const sheet = stockPeriod({ items: ITEMS, rows: ROWS });
  const index = buildStockIndex({ items: ITEMS, movements: MOVEMENTS });
  for (const row of sheet) {
    const entry = index.find((e) => e.name === row.name);
    assert.ok(entry, `${row.name} is on the sheet but not in the index`);
    assert.equal(row.closing, entry.quantity, row.name);
  }
  assert.equal(sheet.length, index.length, "and neither drops an item the other keeps");
});

test("the module reads neither stale quantity field", () => {
  // lastQuantity is typed in by hand and never written by posting;
  // balanceQuantity is a running cache a back-dated entry leaves stale. Both
  // are explained at length in lib/itemStock.mjs.
  const src = code(read("../lib/inventory.mjs"));
  assert.equal(/lastQuantity/.test(src), false);
  assert.equal(/balanceQuantity/.test(src), false);
});

console.log("\n--- the period split ---");

test("the opening is everything before the window, not a zero", () => {
  // Sorted by name, so the row is found rather than indexed.
  const plate = stockPeriod({ items: ITEMS, rows: ROWS, from: "2026-06-01", to: "2026-09-30" })
    .find((r) => r.name === "MS Plate 10mm");
  // 100 opening + 200 received on 10 April.
  assert.equal(plate.opening, 300);
  assert.equal(plate.receipts, 40);
  assert.equal(plate.issues, 250);
  assert.equal(plate.closing, 90);
  assert.equal(plate.unit, "KGS");
  assert.equal(plate.group, "Plates");
  assert.equal(plate.id, "i1", "so a row can reach the item's own ledger");
});

test("a back-dated entry lands in the opening, not in the movements", () => {
  // The whole reason an opening is computed rather than carried forward.
  const late = [...ROWS, { _id: "r9", itemName: "MS Plate 10mm", date: "2026-05-15", invoiceNo: "9", typeOfVoucher: "Purchase", partyName: "Bharat Steel", receiptQuantity: 7, issueQuantity: 0 }];
  const plate = stockPeriod({ items: ITEMS, rows: late, from: "2026-06-01", to: "2026-09-30" })
    .find((r) => r.name === "MS Plate 10mm");
  assert.equal(plate.opening, 307);
  assert.equal(plate.receipts, 40, "and not into the period's receipts");
  assert.equal(plate.closing, 97);
});

test("both ends of the window are inclusive", () => {
  const one = stockPeriod({ items: ITEMS, rows: ROWS, from: "2026-04-10", to: "2026-04-10" });
  const plate = one.find((r) => r.name === "MS Plate 10mm");
  assert.equal(plate.receipts, 200, "the first day counts");
  assert.equal(plate.opening, 100);
  const last = stockPeriod({ items: ITEMS, rows: ROWS, from: "2026-09-20", to: "2026-09-20" });
  assert.equal(last.find((r) => r.name === "MS Plate 10mm").receipts, 40, "the last day counts");
});

test("an item with no movements still appears, at its opening", () => {
  const rows = stockPeriod({ items: ITEMS, rows: ROWS });
  const scrap = rows.find((r) => r.name === "Scrap");
  assert.deepEqual([scrap.opening, scrap.receipts, scrap.issues, scrap.closing], [40, 0, 0, 40]);
});

test("a movement for an item deleted from the master is still counted", () => {
  // A stock sheet that silently omits rows is a stock sheet nobody can
  // reconcile -- the same rule lib/itemStock.mjs follows.
  const ghost = stockPeriod({ items: ITEMS, rows: ROWS }).find((r) => r.name === "Ghost Rod");
  assert.ok(ghost, "the row was dropped");
  assert.deepEqual([ghost.opening, ghost.closing, ghost.id], [0, 12, ""]);
});

test("the IST calendar day decides, not the server's", () => {
  // 19:00 UTC on 31 March is 00:30 IST on 1 April -- the first day of the
  // financial year, and in the period rather than before it.
  const rows = [
    { itemName: "MS Plate 10mm", date: "2026-03-31T19:00:00Z", invoiceNo: "1", typeOfVoucher: "Purchase", partyName: "X", receiptQuantity: 5, issueQuantity: 0 },
  ];
  const [plate] = stockPeriod({ items: [ITEMS[0]], rows, from: "2026-04-01", to: "2027-03-31" });
  assert.equal(plate.receipts, 5, "00:30 IST on 1 April is in the year");
  assert.equal(plate.opening, 100);
});

test("the totals foot the columns", () => {
  const rows = stockPeriod({ items: ITEMS, rows: ROWS, from: "2026-04-01", to: "2027-03-31" });
  const t = stockPeriodTotals(rows);
  assert.equal(t.items, 4);
  assert.equal(t.opening, 140, "100 plate + 0 washer + 40 scrap + 0 ghost");
  assert.equal(t.receipts, 252);
  assert.equal(t.issues, 330);
  assert.equal(t.closing, 62);
  // No value column on a plain summary, so no money total is implied.
  assert.equal(t.value, null);
});

test("quantities keep three decimals, because kilos are not paise", () => {
  assert.equal(round3(0.1255), 0.126);
  assert.equal(round3(12.5), 12.5);
  const rows = stockPeriod({
    items: [{ name: "Oil", openingQuantity: 0.125 }],
    rows: [{ itemName: "Oil", date: "2026-05-01", invoiceNo: "1", typeOfVoucher: "Purchase", partyName: "X", receiptQuantity: 0.25, issueQuantity: 0 }],
  });
  assert.equal(rows[0].closing, 0.375);
});

console.log("\n--- which document a row came off ---");

test("a sales return is told from a sale by its DIRECTION", () => {
  // The writer records only "Sale" or "Purchase" and not the return flag
  // (lib/itemLedger.mjs), so the direction supplies what the column does
  // not -- which is sound, because inward on a Sale can only be a return.
  assert.equal(voucherTypeOf({ typeOfVoucher: "Sale", invoiceNo: "12", issueQuantity: 250 }), "Sale");
  assert.equal(voucherTypeOf({ typeOfVoucher: "Sale", invoiceNo: "12", receiptQuantity: 5 }), "Sales Return");
  assert.equal(voucherTypeOf({ typeOfVoucher: "Purchase", invoiceNo: "3", receiptQuantity: 9 }), "Purchase");
  assert.equal(voucherTypeOf({ typeOfVoucher: "Purchase", invoiceNo: "3", issueQuantity: 9 }), "Purchase Return");
});

test("the three stock vouchers are told apart by their key's prefix", () => {
  // `typeOfVoucher` is hardcoded to "Production" for all three kinds.
  assert.equal(voucherTypeOf({ typeOfVoucher: "Production", invoiceNo: "PRD-5" }), "Production");
  assert.equal(voucherTypeOf({ typeOfVoucher: "Production", invoiceNo: "GI-5", issueQuantity: 3 }), "Goods Issued");
  assert.equal(voucherTypeOf({ typeOfVoucher: "Production", invoiceNo: "GR-5", receiptQuantity: 3 }), "Goods Received");
});

console.log("\n--- Sigfa's own column names ---");

test("the captions are Sigfa's, not ours", () => {
  // Read out of the binary. A client who has used Sigfa for fifteen years
  // looks for these words.
  assert.deepEqual(headings(STOCK_COLUMNS), [
    "Item Name", "Unit", "Opening Quantity", "Rcpt. Qty.", "Issue Qty.", "Balance Qty.",
  ]);
  assert.deepEqual(headings(DAY_BOOK_COLUMNS).slice(0, 4), [
    "Date", "Vch Type", "Voucher", "Party Name",
  ]);
  // "Required" is Sigfa's heading for the shortfall.
  assert.ok(headings(SHORT_COLUMNS).includes("Required"));
  assert.ok(headings(SHORT_COLUMNS).includes("Minimum Level"));
  assert.ok(headings(SHORT_COLUMNS).includes("Re-Order Level"));
  assert.ok(headings(PHYSICAL_COLUMNS).includes("Physical Stock"));
  assert.deepEqual(headings(valueColumns()).slice(-2), ["Rate", "Value"]);
});

test("a quantity column is written as a NUMBER, not as text", () => {
  // A spreadsheet column of strings cannot be summed, which is the first
  // thing anyone does to a stock sheet.
  for (const key of ["opening", "receipts", "issues", "closing"]) {
    assert.equal(STOCK_COLUMNS.find((c) => c.key === key).type, "qty", key);
  }
  assert.equal(valueColumns().find((c) => c.key === "value").type, "money");
});

test("every column reads a key that is actually on its rows", () => {
  // A column whose key nothing carries prints an empty sheet with headings.
  const summary = stockPeriod({ items: ITEMS, rows: ROWS })[0];
  for (const c of STOCK_COLUMNS) assert.ok(c.key in summary, c.key);
  const short = shortList({ items: ITEMS, movements: MOVEMENTS, reasons: STOCK_REASONS })[0];
  for (const c of SHORT_COLUMNS) assert.ok(c.key in short, c.key);
  const book = dayBook({ rows: ROWS })[0];
  for (const c of DAY_BOOK_COLUMNS) assert.ok(c.key in book, c.key);
  const counted = compareCount({ items: ITEMS, movements: MOVEMENTS, counted: [{ name: "Scrap", quantity: 1 }] })[0];
  for (const c of PHYSICAL_COLUMNS) assert.ok(c.key in counted, c.key);
  // The aging slabs live in an array on the row, so those columns carry a
  // value() instead of a key.
  const aged = agingOf({ items: ITEMS, rows: ROWS, asOf: "2026-10-12" })[0];
  for (const c of agingColumns()) {
    assert.ok(c.key in aged || typeof c.value === "function", c.key);
  }
});

console.log("\n--- the filters ---");

test("Sigfa's 'Print Only Negative Stock' is one of them", () => {
  assert.deepEqual(STOCK_FILTERS, ["all", "negative", "nonzero", "moved"]);
  assert.equal(DEFAULT_FILTER, "all");
  assert.equal(isStockFilter("negative"), true);
  assert.equal(isStockFilter("nope"), false);
  assert.ok(FILTER_LABELS.negative);

  const rows = [
    { name: "A", closing: -5, receipts: 0, issues: 5 },
    { name: "B", closing: 0, receipts: 0, issues: 0 },
    { name: "C", closing: 9, receipts: 9, issues: 0 },
  ];
  assert.deepEqual(applyFilter(rows, "negative").map((r) => r.name), ["A"]);
  assert.deepEqual(applyFilter(rows, "nonzero").map((r) => r.name), ["A", "C"]);
  assert.deepEqual(applyFilter(rows, "moved").map((r) => r.name), ["A", "C"]);
  assert.equal(applyFilter(rows, "all").length, 3);
  assert.equal(applyFilter(rows, "nonsense").length, 3, "an unknown filter shows everything");
});

console.log("\n--- the three levels ---");

test("a level that was never set is null, never zero", () => {
  assert.equal(levelOf(ITEMS[2], "minQuantity"), null);
  assert.equal(levelOf({ minQuantity: 0 }, "minQuantity"), 0, "but a typed zero is a typed zero");
  assert.equal(levelOf({ minQuantity: "" }, "minQuantity"), null);
  assert.deepEqual(levelsOf(ITEMS[0]), { minimum: 25, reorder: 60, maximum: 5000 });
  assert.deepEqual(levelsOf({}), { minimum: null, reorder: null, maximum: null });
});

test("a maximum under a minimum is the two boxes swapped, and refused", () => {
  assert.equal(levelProblem(ITEMS[0]), null);
  assert.equal(levelProblem({}), null, "none set is fine");
  assert.match(levelProblem({ minQuantity: 50, maxLevel: 10 }), /maximum level is below the minimum/);
  assert.match(levelProblem({ reorderLevel: 50, maxLevel: 10 }), /below the re-order level/);
  assert.match(levelProblem({ minQuantity: -1 }), /Minimum Level cannot be negative/);
  assert.match(levelProblem({ reorderLevel: -1 }), /Re-Order Level cannot be negative/);
  assert.match(levelProblem({ maxLevel: -1 }), /Maximum Level cannot be negative/);
  // The re-order level ABOVE the minimum is the normal arrangement, not an
  // error -- you order again before you reach the floor.
  assert.equal(levelProblem({ minQuantity: 25, reorderLevel: 60 }), null);
});

test("THE SHORT LIST DOES NOT KEEP ITS OWN RULE", () => {
  // It calls lowStockRows, so the dashboard tile and the printed sheet
  // cannot disagree about an item.
  const stock = buildStockIndex({ items: ITEMS, movements: MOVEMENTS });
  assert.deepEqual(
    shortList({ items: ITEMS, stock, reasons: STOCK_REASONS }),
    lowStockRows({ stock, items: ITEMS, reasons: STOCK_REASONS })
  );
  const src = code(read("../lib/inventory.mjs"));
  assert.match(src, /lowStockRows\(\{ stock: index, items, reasons \}\)/);
});

test("the sheet asks for all five reasons; the dashboard tile asks for three", () => {
  const stock = buildStockIndex({ items: ITEMS, movements: MOVEMENTS });
  const sheet = shortList({ items: ITEMS, stock, reasons: STOCK_REASONS });
  // Washer: 0 - 80 = -80, negative. Plate: 90, which is above its minimum of
  // 25 but below its re-order level of 60... no: 90 > 60, so it is fine.
  assert.deepEqual(sheet.map((r) => [r.name, r.reason]), [["Washer 12mm", "negative"]]);
  assert.deepEqual(DASHBOARD_REASONS, ["negative", "out", "below"]);
  assert.equal(STOCK_REASONS.length, 5);

  // Now one item below its re-order level only: on the sheet, not on the tile.
  const items = [{ name: "Bolt", openingQuantity: 40, minQuantity: 25, reorderLevel: 60 }];
  const s2 = buildStockIndex({ items, movements: [] });
  assert.deepEqual(shortList({ items, stock: s2, reasons: STOCK_REASONS }).map((r) => r.reason), ["reorder"]);
  assert.deepEqual(lowStockRows({ stock: s2, items }), []);
});

test("the cards say how much of the master has a level at all", () => {
  const stock = buildStockIndex({ items: ITEMS, movements: MOVEMENTS });
  const rows = shortList({ items: ITEMS, stock, reasons: STOCK_REASONS });
  const summary = shortListSummary({ items: ITEMS, stock, rows });
  assert.equal(summary.alerts, rows.length);
  assert.equal(summary.items, 4, "three in the master and one ghost");
  assert.equal(summary.withMinimum, 2);
  assert.equal(summary.withoutMinimum, 1);
});

console.log("\n--- ageing, which IS a FIFO question ---");

test("the receipts still on the shelf are the oldest ones the issues did not eat", () => {
  // 100 opening (1 April) + 200 on 10 April, 250 issued: the opening goes
  // first, then 150 of the April receipt, leaving 50 of it.
  const { layers, shortfall } = agingLayers({
    opening: 100,
    openingDate: "2026-04-01",
    rows: ROWS.filter((r) => r.itemName === "MS Plate 10mm"),
  });
  assert.equal(shortfall, 0);
  assert.deepEqual(layers.map((l) => [l.day, l.quantity]), [
    [20260410, 50],
    [20260920, 40],
  ]);
});

test("an over-issue is covered by the NEXT receipt before any of it is aged", () => {
  // Otherwise a shop that billed before the bill arrived shows the same
  // goods as both missing and sitting on a shelf.
  const rows = [
    { itemName: "X", date: "2026-05-01", invoiceNo: "1", typeOfVoucher: "Sale", receiptQuantity: 0, issueQuantity: 30 },
    { itemName: "X", date: "2026-06-01", invoiceNo: "2", typeOfVoucher: "Purchase", receiptQuantity: 50, issueQuantity: 0 },
  ];
  const { layers, shortfall } = agingLayers({ opening: 0, rows });
  assert.equal(shortfall, 0);
  assert.deepEqual(layers.map((l) => l.quantity), [20]);
});

test("issuing more than was ever received leaves nothing on the shelf", () => {
  const rows = [
    { itemName: "X", date: "2026-05-01", invoiceNo: "1", typeOfVoucher: "Purchase", receiptQuantity: 5, issueQuantity: 0 },
    { itemName: "X", date: "2026-06-01", invoiceNo: "2", typeOfVoucher: "Sale", receiptQuantity: 0, issueQuantity: 9 },
  ];
  const { layers, shortfall } = agingLayers({ opening: 0, rows });
  assert.deepEqual(layers, []);
  assert.equal(shortfall, 4);
});

test("the carried-forward stock is the oldest layer of all", () => {
  const { layers } = agingLayers({ opening: 10, openingDate: "2026-04-01", rows: [] });
  assert.deepEqual(layers.map((l) => [l.quantity, l.opening]), [[10, true]]);
  // Nothing carried forward is not a layer of zero.
  assert.deepEqual(agingLayers({ opening: 0, rows: [] }).layers, []);
});

test("the slabs read the way Sigfa's printer setup types them", () => {
  assert.deepEqual(DEFAULT_AGING_SLABS, [30, 60, 90, 180]);
  assert.deepEqual(slabLabels(), [
    "0-30 days", "31-60 days", "61-90 days", "91-180 days", "Above 180 days",
  ]);
  assert.deepEqual(slabLabels([7]), ["0-7 days", "Above 7 days"]);
  // The boundary belongs to the slab it names: 30 days old is 0-30.
  assert.equal(slabIndexOf(0), 0);
  assert.equal(slabIndexOf(30), 0);
  assert.equal(slabIndexOf(31), 1);
  assert.equal(slabIndexOf(180), 3);
  assert.equal(slabIndexOf(181), 4);
});

test("a slab list that makes no sense is refused", () => {
  assert.equal(slabProblem([30, 60]), null);
  assert.match(slabProblem([]), /at least one/);
  assert.match(slabProblem(null), /at least one/);
  assert.match(slabProblem([60, 30]), /must increase/);
  assert.match(slabProblem([30, 30]), /must increase/);
  assert.match(slabProblem([0]), /whole number of days/);
  assert.match(slabProblem([-5]), /whole number of days/);
  assert.match(slabProblem([1.5]), /whole number of days/);
  assert.match(slabProblem([1, 2, 3, 4, 5, 6, 7]), /at most/);
});

test("the sheet spreads each item's stock across the slabs", () => {
  const rows = agingOf({ items: ITEMS, rows: ROWS, asOf: "2026-10-12", openingDate: "2026-04-01" });
  const plate = rows.find((r) => r.name === "MS Plate 10mm");
  assert.equal(plate.onHand, 90, "and it foots to the closing quantity");
  // 50 KGS received 10 April is 185 days old; 40 received 20 September is 22.
  assert.deepEqual(plate.buckets, [40, 0, 0, 0, 50]);
  assert.equal(plate.oldestDays, 185);
  assert.equal(plate.newestDays, 22);
  // Oldest first, because that is the row somebody acts on. Scrap's whole
  // quantity is carried-forward stock dated 1 April, which is older than
  // anything received since.
  assert.equal(rows[0].name, "Scrap");
  assert.equal(rows[0].oldestDays, 194);
  // An item with nothing on the shelf has no age.
  const washer = rows.find((r) => r.name === "Washer 12mm");
  assert.equal(washer.onHand, 0);
  assert.equal(washer.oldestDays, null);
});

test("stock of unknown age goes in the OLDEST slab, not the newest", () => {
  // An opening quantity on a firm that has not said when its books start.
  const rows = agingOf({ items: [{ name: "Old", openingQuantity: 5 }], rows: [], asOf: "2026-10-12" });
  assert.equal(rows[0].buckets[rows[0].buckets.length - 1], 5);
  assert.equal(rows[0].onHand, 5);
});

test("the ageing totals foot each slab", () => {
  const rows = agingOf({ items: ITEMS, rows: ROWS, asOf: "2026-10-12", openingDate: "2026-04-01" });
  const t = agingTotals(rows);
  assert.equal(t.onHand, round3(rows.reduce((s, r) => s + r.onHand, 0)));
  assert.equal(t.buckets.length, slabLabels().length);
  assert.equal(round3(t.buckets.reduce((s, b) => s + b, 0)), t.onHand);
});

console.log("\n--- valuation: five of Sigfa's seven ---");

test("Sigfa's seven bases are all listed, in its own words", () => {
  assert.deepEqual(VALUATION_BASES.map((b) => b.name), [
    "Weighted Rate",
    "On Last Purc Price",
    "On Purchase Price",
    "On Cost Price",
    "On MRP",
    "Fifo Basis",
    "Lifo Basis",
  ]);
  assert.deepEqual(SUPPORTED_BASES, ["weighted", "lastPurchase", "purchase", "cost", "mrp"]);
  assert.equal(DEFAULT_BASIS, "cost", "the basis the balance sheet already uses");
});

test("FIFO AND LIFO ARE REFUSED, WITH THE REASON", () => {
  // The stock ledger has no rate column, so there is no rate to attach to a
  // surviving layer. A number labelled FIFO that is not FIFO would be
  // carried into a balance sheet.
  assert.match(basisProblem("fifo"), /cannot be computed/);
  assert.match(basisProblem("fifo"), /no rate to attach/);
  assert.match(basisProblem("lifo"), /cannot be computed/);
  assert.equal(basisOf("fifo").supported, false);
  assert.equal(basisOf("lifo").supported, false);
  // And nothing silently falls back.
  assert.equal(rateFor({ basis: "fifo", item: ITEMS[0] }), null);
  assert.match(basisProblem("salePrice"), /is not a valuation basis/);
  for (const key of SUPPORTED_BASES) assert.equal(basisProblem(key), null, key);
});

test("the sale price is not a basis at any price", () => {
  // Valuing stock at what it sells for books the profit before the sale, and
  // Sigfa does not offer it either.
  assert.equal(VALUATION_BASES.some((b) => /sale/i.test(b.key)), false);
  const src = code(read("../lib/inventory.mjs"));
  assert.equal(/salePrice/.test(src.replace(/`[^`]*`/g, "")), false);
});

test("THE WEIGHTED RATE IS itemWise's, not a second average", () => {
  const rates = weightedRates({ invoices: INVOICES });
  const fromReports = itemWise({ invoices: INVOICES, side: "Purchase" }).find(
    (r) => r.item === "MS Plate 10mm"
  );
  assert.equal(rates.get("ms plate 10mm"), fromReports.rate);
  // 10400 + 3000 - 1000 over 200 + 50 - 10: the return nets off, which is
  // right for a cost.
  assert.equal(rates.get("ms plate 10mm"), 51.67);
  // A sale's rate is nowhere near it.
  assert.notEqual(rates.get("ms plate 10mm"), 90);
});

test("the last purchase rate is the line's rate, and skips returns", () => {
  const rates = lastPurchaseRates({ invoices: INVOICES });
  // 60 on 2 August, not 999 on the 1 September return and not 90 on the sale.
  assert.equal(rates.get("ms plate 10mm"), 60);
  // Bounded, so a valuation as at 30 June is not made with August's rate.
  assert.equal(lastPurchaseRates({ invoices: INVOICES, upto: "2026-06-30" }).get("ms plate 10mm"), 52);
  assert.equal(lastPurchaseRates({ invoices: INVOICES, upto: "2026-03-31" }).size, 0);
});

test("a missing rate is null, never a zero that writes the stock off", () => {
  assert.equal(rateFor({ basis: "cost", item: ITEMS[2] }), null, "Scrap has no cost");
  assert.equal(rateFor({ basis: "cost", item: { cost: 0 } }), null);
  assert.equal(rateFor({ basis: "purchase", item: ITEMS[1] }), null, "no purchasePrice");
  assert.equal(rateFor({ basis: "mrp", item: ITEMS[0] }), 70);
  assert.equal(rateFor({ basis: "weighted", item: ITEMS[0], weighted: new Map() }), null);
  assert.equal(rateFor({ basis: "weighted", item: ITEMS[0] }), null, "no map, no rate");
});

test("VALUED AT COST, THIS SHEET IS THE BALANCE SHEET'S CLOSING STOCK", () => {
  // lib/financials.mjs's stockValue is the figure the balance sheet carries.
  // Two different numbers for the same stock is the drift this pins shut.
  const rows = valueRows({ rows: stockPeriod({ items: ITEMS, rows: ROWS }), items: ITEMS, basis: "cost" });
  const mine = valueCoverage(rows);
  const theirs = stockValue({
    stock: buildStockIndex({ items: ITEMS, movements: MOVEMENTS }),
    items: ITEMS,
  });
  assert.equal(mine.valuedTotal, theirs.value);
  assert.equal(mine.valued, theirs.valued);
  assert.equal(mine.items, theirs.held);
  assert.equal(mine.unvalued, theirs.missingCosts.length);
});

test("what could not be valued is counted, and keeps the total honest", () => {
  const rows = valueRows({ rows: stockPeriod({ items: ITEMS, rows: ROWS }), items: ITEMS, basis: "cost" });
  const coverage = valueCoverage(rows);
  // Scrap (40 KGS, no cost) and Ghost Rod (12, not in the master).
  assert.equal(coverage.unvalued, 2);
  assert.deepEqual(coverage.names.sort(), ["Ghost Rod", "Scrap"]);
  // The headline total goes NULL the moment one row is unvalued -- a stock
  // value that silently excluded a third of the shelf is the figure that
  // ends up in a balance sheet.
  assert.equal(coverage.total, null);
  // And the figure for the rows that DO have a rate is always available:
  // 90 KGS of plate at 55, less 80 washers at 2 that were billed before they
  // were received. A NEGATIVE quantity is valued, not skipped -- the same
  // rule lib/financials.mjs's stockValue follows, and the reason the sheet
  // and the balance sheet agree.
  assert.equal(coverage.valuedTotal, 4790);
  // An item holding NOTHING is not part of the coverage either way; one
  // holding a negative quantity is.
  assert.equal(coverage.items, 4);
  assert.equal(coverage.valued, 2);
});

test("a value row carries a null value rather than a zero", () => {
  const rows = valueRows({ rows: stockPeriod({ items: ITEMS, rows: ROWS }), items: ITEMS, basis: "cost" });
  const scrap = rows.find((r) => r.name === "Scrap");
  assert.equal(scrap.rate, null);
  assert.equal(scrap.value, null);
  const plate = rows.find((r) => r.name === "MS Plate 10mm");
  assert.equal(plate.value, 4950);
  // The quantity columns are untouched by valuing the sheet.
  assert.equal(plate.closing, 90);
});

console.log("\n--- the day book ---");

test("every movement, in date order, whatever order they arrived in", () => {
  const rows = dayBook({ rows: ROWS, from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(rows.map((r) => r.voucher), ["11", "12", "13", "14", "GR-3"]);
  assert.deepEqual(rows.map((r) => r.voucherType), [
    "Purchase", "Sale", "Sale", "Purchase", "Goods Received",
  ]);
  assert.equal(rows[0].party, "Bharat Steel");
  assert.equal(rows[0].item, "MS Plate 10mm");
  assert.equal(rows[0].received, 200);
  assert.equal(rows[0].issued, 0);
});

test("it can be narrowed to one item, and to a window", () => {
  assert.equal(dayBook({ rows: ROWS, item: "MS Plate 10mm" }).length, 3);
  assert.equal(dayBook({ rows: ROWS, item: "ms plate 10mm" }).length, 3, "the name is not case-bound");
  assert.equal(dayBook({ rows: ROWS, item: "Nothing" }).length, 0);
  assert.equal(dayBook({ rows: ROWS, from: "2026-07-01", to: "2026-07-31" }).length, 2);
});

test("it carries no running balance, and says where to get one", () => {
  // A day book spanning every item cannot carry one meaningfully.
  const row = dayBook({ rows: ROWS })[0];
  assert.equal("balance" in row, false);
  assert.equal(headings(DAY_BOOK_COLUMNS).includes("Balance Qty."), false);
  assert.match(read("../app/stock-report/page.js"), /\/item-ledger/);
});

test("the day book totals count items as well as movements", () => {
  const t = dayBookTotals(dayBook({ rows: ROWS }));
  assert.equal(t.movements, 5);
  assert.equal(t.items, 3, "plate, washer and the ghost");
  assert.equal(t.received, 252);
  assert.equal(t.issued, 330);
});

console.log("\n--- the physical count ---");

test("the book figure is recomputed, not a stored snapshot", () => {
  // Sigfa's PHYSTOCK stores AsOnBal, the book figure when the count was
  // taken. A count typed last week should be compared against what the books
  // say NOW, which is the question being asked.
  const rows = compareCount({
    items: ITEMS,
    movements: MOVEMENTS,
    counted: [
      { name: "MS Plate 10mm", quantity: 85 },
      { name: "Scrap", quantity: 40 },
      { name: "Mystery Rod", quantity: 3 },
    ],
  });
  const plate = rows.find((r) => r.name === "MS Plate 10mm");
  assert.equal(plate.book, 90);
  assert.equal(plate.counted, 85);
  assert.equal(plate.difference, -5, "counted minus book: five short");
  assert.equal(plate.inMaster, true);
  // Found on the shelf with no master at all, which is what a count is for.
  const mystery = rows.find((r) => r.name === "Mystery Rod");
  assert.deepEqual([mystery.book, mystery.counted, mystery.difference, mystery.inMaster], [0, 3, 3, false]);
  // Biggest discrepancy first.
  assert.equal(rows[0].name, "MS Plate 10mm");
  const t = countTotals(rows);
  assert.deepEqual([t.items, t.agree, t.short, t.excess], [3, 1, 1, 1]);
});

console.log("\n--- the reports, and what they export ---");

test("the five reports are Sigfa's, and only two of them take a period", () => {
  assert.deepEqual(STOCK_REPORT_KEYS, ["summary", "value", "short", "aging", "daybook"]);
  assert.deepEqual(STOCK_REPORTS.map((r) => r.name), [
    "Stock Summary",
    "Stock Summary Value Wise",
    "Stock Short List",
    "Stock Aging Analysis",
    "Stock Day Book",
  ]);
  assert.equal(isStockReport("summary"), true);
  assert.equal(isStockReport("nonsense"), false);
  assert.equal(stockReportName("value"), "Stock Summary Value Wise");
  assert.equal(stockReportName("nope"), "");
  // A level and an age are about stock as it stands, so offering a date range
  // would be offering a filter that cannot change the answer.
  assert.equal(reportTakesPeriod("summary"), true);
  assert.equal(reportTakesPeriod("value"), true);
  assert.equal(reportTakesPeriod("daybook"), true);
  assert.equal(reportTakesPeriod("short"), false);
  assert.equal(reportTakesPeriod("aging"), false);
});

test("a sheet carries its own columns and a title", () => {
  const rows = stockPeriod({ items: ITEMS, rows: ROWS });
  const [sheet] = stockSheets({
    report: "value",
    rows: valueRows({ rows, items: ITEMS, basis: "cost" }),
    from: "2026-04-01",
    to: "2027-03-31",
    basis: "cost",
    company: { name: "Shah Brothers" },
  });
  assert.equal(sheet.title, "Stock Summary Value Wise");
  assert.deepEqual(headings(sheet.columns).slice(-2), ["Rate", "Value"]);
  assert.ok(sheet.meta.some((m) => m.value === "Shah Brothers"));
  assert.ok(sheet.meta.some((m) => m.value === "On Cost Price"));
  assert.equal(stockSheets({ report: "aging", slabs: [7] })[0].columns.length, agingColumns([7]).length);
});

test("the meta block says 'As on' for a sheet with no period, 'Period' for one with", () => {
  const withPeriod = stockMeta({ report: "summary", from: "2026-04-01", to: "2026-06-30", asOf: "2026-10-12" });
  assert.equal(withPeriod.find((m) => m.label === "Period").value, "2026-04-01 to 2026-06-30");
  assert.equal(withPeriod.find((m) => m.label === "As on").value, "");
  const asOn = stockMeta({ report: "short", from: "2026-04-01", to: "2026-06-30", asOf: "2026-10-12" });
  assert.equal(asOn.find((m) => m.label === "Period").value, "");
  assert.equal(asOn.find((m) => m.label === "As on").value, "2026-10-12");
  // The basis only prints on the sheet that has one.
  assert.equal(stockMeta({ report: "summary", basis: "cost" }).find((m) => m.label === "Valuation").value, "");
});

test("a totals row carries ONLY the columns a sum means something for", () => {
  // A "Reason" column under the word Total would read as a reason, and a sum
  // of minimum levels is not a number anybody wants.
  const rows = stockPeriod({ items: ITEMS, rows: ROWS });
  const summary = sheetTotals({ report: "summary", rows });
  assert.deepEqual(Object.keys(summary).sort(), ["closing", "issues", "opening", "receipts"]);
  assert.equal("name" in summary, false);
  assert.equal("value" in summary, false, "no value column on a plain summary");

  // Valued, and every row has a rate: the value total is carried.
  const valued = valueRows({
    rows: [{ name: "MS Plate 10mm", opening: 0, receipts: 0, issues: 0, closing: 90 }],
    items: ITEMS,
    basis: "cost",
  });
  assert.equal(sheetTotals({ report: "value", rows: valued }).value, 4950);
  // One row without a rate and the value total is withheld rather than
  // printed as a partial figure under a column headed Value.
  assert.equal("value" in sheetTotals({ report: "value", rows: valueRows({ rows, items: ITEMS, basis: "cost" }) }), false);

  assert.equal(sheetTotals({ report: "short", rows: [] }), null);
  const book = sheetTotals({ report: "daybook", rows: dayBook({ rows: ROWS }) });
  assert.deepEqual(Object.keys(book).sort(), ["issued", "received"]);
  const aged = sheetTotals({ report: "aging", rows: agingOf({ items: ITEMS, rows: ROWS, asOf: "2026-10-12" }) });
  assert.ok("onHand" in aged);
  assert.ok("slab0" in aged, "and one key per slab, matching the column keys");
  assert.ok(`slab${DEFAULT_AGING_SLABS.length}` in aged);
});

console.log("\n--- the route computes nothing ---");

test("it loads the stock rows UNFILTERED, because the opening needs them", () => {
  const route = read("../app/api/stock-report/route.js");
  // The same reason /api/account-book fetches a party's whole ledger: the
  // Opening Quantity column is everything before `from`.
  assert.match(route, /ItemLedger\.find\(\s*\{\}/);
  assert.match(route, /export const GET = tenantRoute\(handleGET\);/);
  assert.match(route, /export const dynamic = "force-dynamic";/);
});

test("it refuses an unsupported basis rather than valuing some other way", () => {
  const route = read("../app/api/stock-report/route.js");
  assert.match(route, /basisProblem\(basis\)/);
  assert.match(route, /status: 400/);
  // And every other input is validated against the module that owns it.
  for (const guard of ["isStockReport(report)", "isReportFormat(format)", "isStockFilter(filter)", "isPreset(preset)", "slabProblem(slabs)"]) {
    assert.ok(route.includes(guard), guard);
  }
});

test("the route holds no arithmetic of its own", () => {
  const route = code(read("../app/api/stock-report/route.js"));
  // No reduce, no sum, no rate: every figure comes from lib/inventory.mjs.
  assert.equal(/\.reduce\(/.test(route), false);
  assert.equal(/receiptQuantity\s*-\s*/.test(route), false);
  assert.match(route, /stockPeriod\(\{/);
  assert.match(route, /sheetTotals\(\{/);
});

test("the invoices are fetched only for the two bases that read bills", () => {
  const route = code(read("../app/api/stock-report/route.js"));
  assert.match(route, /needsBills/);
  assert.match(route, /basis === "weighted" \|\| basis === "lastPurchase"/);
  // And only the lines, not the whole bill.
  assert.match(route, /"items\.cost": 1/);
});

test("the export is the same route, so it cannot drift from the report", () => {
  const route = read("../app/api/stock-report/route.js");
  assert.match(route, /reportResponse\(\{/);
  assert.match(route, /formatOf\(searchParams\)/);
  // No second endpoint to keep in step with the permission table.
  assert.equal(fs.existsSync(new URL("../app/api/stock-export/route.js", import.meta.url)), false);
});

console.log("\n--- the screen computes nothing either ---");

test("the page renders what the route sent and sums nothing", () => {
  const page = code(read("../app/stock-report/page.js"));
  assert.equal(/\.reduce\(/.test(page), false, "the page is summing something");
  assert.match(page, /data\?\.rows \|\| \[\]/);
  assert.match(page, /\/api\/stock-report\?/);
  // The footer reads the totals object rather than adding up the column.
  assert.match(page, /totals\[column\.key\]/);
});

test("the two bases it cannot offer are shown and disabled, not hidden", () => {
  // Somebody looking for FIFO deserves to be told why it is not there.
  const page = read("../app/stock-report/page.js");
  assert.match(page, /disabled=\{!b\.supported\}/);
  assert.match(page, /not available/);
});

test("the sheet that takes no period does not offer a date filter", () => {
  const page = read("../app/stock-report/page.js");
  assert.match(page, /takesPeriod \? \(/);
  assert.match(page, /takes no date range/);
});

test("the page prints the firm through the shared letterhead", () => {
  // Which details print is the firm's own choice (lib/invoicePrefs.mjs) and
  // it must be the same choice here as on the bill.
  const page = read("../app/stock-report/page.js");
  assert.match(page, /<CompanyLogo company=\{company\}/);
  assert.match(page, /<CompanyBrand company=\{company\}/);
  assert.equal(/company\.gstin/.test(page), false, "that would ignore the firm's print preferences");
});

console.log("\n--- the item master and permissions ---");

test("the three levels are declared, because strict mode drops what is not", () => {
  const model = read("../models/itemModel.js");
  for (const field of ["minQuantity", "reorderLevel", "maxLevel"]) {
    assert.match(model, new RegExp(`${field}\\s*:\\s*\\{`), field);
  }
  // And both master routes allowlist them, or an Alter wipes what the form
  // sent -- see lib/masterActions.mjs and §6.21.
  for (const route of ["../app/api/item-add/route.js", "../app/api/item-alter/route.js"]) {
    const src = read(route);
    assert.match(src, /reorderLevel/, route);
    assert.match(src, /maxLevel/, route);
  }
  assert.match(read("../lib/masterActions.mjs"), /reorderBal: record\.reorderLevel/);
  assert.match(read("../lib/masterActions.mjs"), /maxBal: record\.maxLevel/);
});

test("the form refuses a swapped pair before it posts", () => {
  const form = read("../app/itemadd/page.js");
  assert.match(form, /levelProblem\(\{/);
  assert.match(form, /Re-Order Level/);
  assert.match(form, /Maximum Level/);
});

test("the reports are behind the same rule as the financial statements", () => {
  // The value-wise sheet is where the balance sheet's closing stock comes
  // from, so it is the firm's position rather than one item's history.
  assert.equal(permissionForPath("/stock-report"), "report:read");
  assert.equal(permissionForPath("/api/stock-report"), permissionForPath("/stock-report"));
  for (const role of ["owner", "accountant", "biller"]) {
    assert.equal(
      canAccessPath(role, "/api/stock-report"),
      canAccessPath(role, "/stock-report"),
      role
    );
  }
  assert.equal(canAccessPath("biller", "/stock-report"), false, "a biller has no business here");
});

test("nothing in the pure module touches Mongoose", () => {
  const src = read("../lib/inventory.mjs");
  assert.equal(/import mongoose/.test(src), false);
  assert.equal(/from "\.\.\/models/.test(src), false);
  assert.equal(/fetch\(/.test(code(src)), false);
});

console.log(`\n  ${passed} checks passed\n`);
