/**
 * Inventory: the stock figure, the movement history, the valuation, and the
 * posting paths that feed them.
 *
 *   node scripts/inventory-reports.test.mjs
 *
 * The stock ledger is replayed in memory the way the routes write it -- an
 * invoice's rows keyed by its number and written with lib/balance.mjs's
 * direction rule, a stock voucher's by lib/stockVoucher.mjs -- and edits,
 * deletions and back-dated entries are applied the way the routes apply them
 * (delete the document's rows, write the new ones). Then the REAL report
 * builders are asked what the stock is. The invariants:
 *
 *   stock = opening + receipts - issues, whatever order things happened in
 *   a return reverses the movement of the document it returns
 *   an edit replaces, a delete removes -- nothing is left behind
 *   every view (summary, movements, valuation, dashboard index) agrees
 *
 * The last section reads the route and page sources, as the other suites do.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { isInwardStock } from "../lib/balance.mjs";
import { buildStockIndex, stockOf } from "../lib/itemStock.mjs";
import { stockMovements, stockLedgerKey } from "../lib/stockVoucher.mjs";
import { stockValue } from "../lib/financials.mjs";
import { lowStockRows } from "../lib/dashboard.mjs";
import {
  COSTING_METHOD,
  MOVEMENT_TYPES,
  inventorySheets,
  movementRows,
  movementTotals,
  movementType,
  stockSummaryRows,
  stockSummaryTotals,
  valuationRows,
} from "../lib/inventoryReports.mjs";
import { TRANSACTION_COLLECTIONS } from "../lib/clearData.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";
import { REPORT_QUERIES, buildReportQuery, parseReportQuery } from "../lib/reportQuery.mjs";

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

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/* ------------------------------------------------- the in-memory ledger -- */

const at = (iso) => new Date(`${iso}T00:00:00.000Z`);
let seq = 0;

const book = () => ({ rows: [] });

/** lib/itemLedger.mjs writeItemLedgerRows, replayed: delete by number, then write. */
const postInvoice = (b, { invoiceNo, date, type, isReturn = false, party = "Party", lines }) => {
  b.rows = b.rows.filter((r) => r.invoiceNo !== String(invoiceNo));
  const inward = isInwardStock({ type, isReturn });
  for (const l of lines) {
    seq += 1;
    b.rows.push({
      _id: String(seq).padStart(6, "0"),
      date: at(date),
      invoiceNo: String(invoiceNo),
      typeOfVoucher: type,
      partyName: party,
      itemName: l.name,
      receiptQuantity: inward ? l.quantity : 0,
      issueQuantity: inward ? 0 : l.quantity,
    });
  }
};

/** delete-invoice, replayed. */
const deleteInvoice = (b, invoiceNo) => {
  b.rows = b.rows.filter((r) => r.invoiceNo !== String(invoiceNo));
};

/** writeProductionLedgerRows, replayed. */
const postVoucher = (b, { kind, docNo, date, outputItem, outputQuantity, lines }) => {
  const key = stockLedgerKey(kind, docNo);
  b.rows = b.rows.filter((r) => r.invoiceNo !== key);
  const { issues, receipts } = stockMovements({ kind, outputItem, outputQuantity, lines });
  for (const r of [...receipts.map((x) => ({ ...x, receipt: true })), ...issues.map((x) => ({ ...x, receipt: false }))]) {
    seq += 1;
    b.rows.push({
      _id: String(seq).padStart(6, "0"),
      date: at(date),
      invoiceNo: key,
      typeOfVoucher: "Production",
      partyName: "Production",
      itemName: r.itemName,
      receiptQuantity: r.receipt ? r.quantity : 0,
      issueQuantity: r.receipt ? 0 : r.quantity,
    });
  }
};

/** The `$group` the routes run, in memory. `match` filters the rows first. */
const aggregate = (rows, match = () => true) => {
  const m = new Map();
  for (const r of rows.filter(match)) {
    const g = m.get(r.itemName) || { _id: r.itemName, received: 0, issued: 0 };
    g.received += r.receiptQuantity;
    g.issued += r.issueQuantity;
    m.set(r.itemName, g);
  }
  return [...m.values()];
};

const stockNow = (b, items) => buildStockIndex({ items, movements: aggregate(b.rows) });
const qtyOf = (b, items, name) => stockOf(stockNow(b, items), name)?.quantity ?? null;

const ITEMS = [
  { _id: "i1", name: "Widget", unit: "PCS", hsn: "8471", openingQuantity: 10, minQuantity: 5, cost: 100 },
  { _id: "i2", name: "Bolt", unit: "KGS", hsn: "7318", openingQuantity: 0, minQuantity: null, cost: 2.5 },
  { _id: "i3", name: "Steel Rod", unit: "MTR", hsn: "7214", openingQuantity: 50, cost: 0 },
  { _id: "i4", name: "Install", unit: "NOS", hsn: "9987", openingQuantity: 0, isService: true, cost: 0 },
  { _id: "i5", name: "Frame", unit: "PCS", hsn: "9403", openingQuantity: 0, cost: 400 },
];

/* ================================================== receipts and issues == */

console.log("\n--- receipts, issues and returns ---");

test("a purchase receives, a sale issues", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-01", type: "Purchase", lines: [{ name: "Bolt", quantity: 40 }] });
  postInvoice(b, { invoiceNo: 2, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 3 }] });
  assert.equal(qtyOf(b, ITEMS, "Bolt"), 40);
  assert.equal(qtyOf(b, ITEMS, "Widget"), 7, "opening 10 less 3 sold");
});

test("a sale return puts stock back; a purchase return takes it out", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 4 }] });
  postInvoice(b, { invoiceNo: 2, date: "2026-04-03", type: "Sale", isReturn: true, lines: [{ name: "Widget", quantity: 1 }] });
  postInvoice(b, { invoiceNo: 3, date: "2026-04-04", type: "Purchase", lines: [{ name: "Bolt", quantity: 20 }] });
  postInvoice(b, { invoiceNo: 4, date: "2026-04-05", type: "Purchase", isReturn: true, lines: [{ name: "Bolt", quantity: 5 }] });
  assert.equal(qtyOf(b, ITEMS, "Widget"), 7);
  assert.equal(qtyOf(b, ITEMS, "Bolt"), 15);
});

test("the movement history names returns as returns", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 4 }] });
  postInvoice(b, { invoiceNo: 2, date: "2026-04-03", type: "Sale", isReturn: true, lines: [{ name: "Widget", quantity: 1 }] });
  postInvoice(b, { invoiceNo: 3, date: "2026-04-04", type: "Purchase", lines: [{ name: "Bolt", quantity: 20 }] });
  postInvoice(b, { invoiceNo: 4, date: "2026-04-05", type: "Purchase", isReturn: true, lines: [{ name: "Bolt", quantity: 5 }] });
  postVoucher(b, { kind: "IS", docNo: 1, date: "2026-04-06", lines: [{ itemName: "Bolt", quantity: 2 }] });
  postVoucher(b, { kind: "RS", docNo: 1, date: "2026-04-07", lines: [{ itemName: "Bolt", quantity: 1 }] });
  const types = movementRows({ items: ITEMS, rows: b.rows }).map((r) => r.type);
  assert.deepEqual(types, ["sale", "sale-return", "purchase", "purchase-return", "goods-issued", "goods-received"]);
  assert.equal(MOVEMENT_TYPES["sale-return"], "Sale return");
  assert.equal(movementType({ invoiceNo: "PRD-4", receiptQuantity: 5 }), "production");
  assert.equal(movementType({ invoiceNo: "9", typeOfVoucher: "Weird" }), "other");
});

test("production issues materials and receives the output", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-01", type: "Purchase", lines: [{ name: "Bolt", quantity: 10 }] });
  postVoucher(b, {
    kind: "FR", docNo: 1, date: "2026-04-05", outputItem: "Frame", outputQuantity: 2,
    lines: [{ itemName: "Steel Rod", quantity: 8, kind: "material" }, { itemName: "Bolt", quantity: 4, kind: "material" }],
  });
  assert.equal(qtyOf(b, ITEMS, "Frame"), 2);
  assert.equal(qtyOf(b, ITEMS, "Steel Rod"), 42);
  assert.equal(qtyOf(b, ITEMS, "Bolt"), 6);
});

/* ======================================================= edits, deletes == */

console.log("\n--- edits, deletions and back-dated entries ---");

test("an edit replaces the old movement rather than adding to it", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 3 }] });
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 5 }] });
  assert.equal(qtyOf(b, ITEMS, "Widget"), 5);
  assert.equal(b.rows.length, 1, "the edited invoice left its old row behind");
});

test("an edit that drops a line takes that item's movement out too", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 3 }, { name: "Bolt", quantity: 1 }] });
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 3 }] });
  assert.equal(qtyOf(b, ITEMS, "Bolt"), 0);
});

test("a sale edited into a return flips its direction", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 3 }] });
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", isReturn: true, lines: [{ name: "Widget", quantity: 3 }] });
  assert.equal(qtyOf(b, ITEMS, "Widget"), 13);
});

test("a delete removes the movement entirely", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 7, date: "2026-04-02", type: "Sale", lines: [{ name: "Widget", quantity: 3 }] });
  deleteInvoice(b, 7);
  assert.equal(qtyOf(b, ITEMS, "Widget"), 10);
  assert.equal(b.rows.length, 0);
});

test("a stock voucher edit and delete behave the same way", () => {
  const b = book();
  postVoucher(b, { kind: "IS", docNo: 3, date: "2026-04-02", lines: [{ itemName: "Steel Rod", quantity: 5 }] });
  postVoucher(b, { kind: "IS", docNo: 3, date: "2026-04-02", lines: [{ itemName: "Steel Rod", quantity: 2 }] });
  assert.equal(qtyOf(b, ITEMS, "Steel Rod"), 48);
  b.rows = b.rows.filter((r) => r.invoiceNo !== stockLedgerKey("IS", 3));
  assert.equal(qtyOf(b, ITEMS, "Steel Rod"), 50);
});

test("an invoice number and a stock voucher number never collide", () => {
  assert.notEqual(stockLedgerKey("IS", 5), "5");
  assert.notEqual(stockLedgerKey("FR", 5), stockLedgerKey("RS", 5));
});

test("a back-dated entry puts every later running quantity right", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-10", type: "Sale", lines: [{ name: "Widget", quantity: 4 }] });
  postInvoice(b, { invoiceNo: 2, date: "2026-04-20", type: "Sale", lines: [{ name: "Widget", quantity: 3 }] });
  // Entered last, dated first.
  postInvoice(b, { invoiceNo: 3, date: "2026-04-05", type: "Purchase", lines: [{ name: "Widget", quantity: 6 }] });
  const rows = movementRows({ items: ITEMS, rows: b.rows }).filter((r) => r.itemName === "Widget");
  assert.deepEqual(rows.map((r) => r.ref), ["3", "1", "2"], "not in date order");
  assert.deepEqual(rows.map((r) => r.running), [16, 12, 9]);
  assert.equal(rows[rows.length - 1].running, qtyOf(b, ITEMS, "Widget"), "the running figure and the summed stock disagree");
});

test("same-day movements run in the order they were written", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-10", type: "Sale", lines: [{ name: "Widget", quantity: 10 }] });
  postInvoice(b, { invoiceNo: 2, date: "2026-04-10", type: "Purchase", lines: [{ name: "Widget", quantity: 5 }] });
  const rows = movementRows({ items: ITEMS, rows: b.rows });
  assert.deepEqual(rows.map((r) => r.running), [0, 5]);
});

/* =============================================== summary and movements == */

console.log("\n--- the period views ---");

const periodBook = () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-03-20", type: "Purchase", lines: [{ name: "Bolt", quantity: 30 }] });
  postInvoice(b, { invoiceNo: 2, date: "2026-04-05", type: "Sale", party: "Shah", lines: [{ name: "Bolt", quantity: 12 }, { name: "Widget", quantity: 6 }] });
  postInvoice(b, { invoiceNo: 3, date: "2026-04-25", type: "Sale", isReturn: true, party: "Shah", lines: [{ name: "Bolt", quantity: 2 }] });
  postInvoice(b, { invoiceNo: 4, date: "2026-05-02", type: "Sale", lines: [{ name: "Install", quantity: 1 }] });
  return b;
};
const before = (b, from) => aggregate(b.rows, (r) => r.date < at(from));
const inside = (b, from, to) => aggregate(b.rows, (r) => r.date >= at(from) && r.date <= at(to));

test("summary: opening at the start of the period, then in, out and closing", () => {
  const b = periodBook();
  const rows = stockSummaryRows({ items: ITEMS, before: before(b, "2026-04-01"), inside: inside(b, "2026-04-01", "2026-04-30") });
  const bolt = rows.find((r) => r.name === "Bolt");
  assert.deepEqual([bolt.opening, bolt.received, bolt.issued, bolt.closing], [30, 2, 12, 20]);
  const widget = rows.find((r) => r.name === "Widget");
  assert.deepEqual([widget.opening, widget.issued, widget.closing], [10, 6, 4]);
  assert.equal(widget.status, "below", "4 is below the minimum of 5");
});

test("summary closing equals the dashboard's stock as at the period end", () => {
  const b = periodBook();
  const rows = stockSummaryRows({ items: ITEMS, before: before(b, "2026-04-01"), inside: inside(b, "2026-04-01", "2026-05-31") });
  const index = buildStockIndex({ items: ITEMS, movements: aggregate(b.rows) });
  for (const r of rows) assert.equal(r.closing, stockOf(index, r.name).quantity, r.name);
});

test("summary filters: search, status, and services are never 'low'", () => {
  const b = periodBook();
  const all = stockSummaryRows({ items: ITEMS, before: [], inside: aggregate(b.rows) });
  const install = all.find((r) => r.name === "Install");
  assert.equal(install.isService, true);
  assert.equal(install.closing, -1);
  assert.equal(install.status, "ok", "a sold service reads as negative stock");
  assert.deepEqual(stockSummaryRows({ items: ITEMS, inside: aggregate(b.rows), q: "73" }).map((r) => r.name), ["Bolt"], "HSN search");
  const low = stockSummaryRows({ items: ITEMS, inside: aggregate(b.rows), status: "low" }).map((r) => r.name);
  assert.ok(low.includes("Widget"));
  assert.ok(!low.includes("Install"));
  const t = stockSummaryTotals(all);
  assert.equal(t.items, all.length);
});

test("a name that differs only in case is its own line everywhere -- never a replaced figure", () => {
  // Master "Widget" (opening 10); a ledger row written as "widget". Every view
  // must treat them as the dashboard and the valuation do: two lines, with
  // the master's opening on its own line, whether or not a From date is set.
  const items = [{ name: "Widget", unit: "PCS", openingQuantity: 10, minQuantity: 5, cost: 100 }];
  const rows = [
    { _id: "1", date: at("2026-04-10"), itemName: "widget", invoiceNo: "9", typeOfVoucher: "Sale", receiptQuantity: 0, issueQuantity: 3 },
  ];
  const all = aggregate(rows);
  const index = buildStockIndex({ items, movements: all });
  for (const summary of [
    stockSummaryRows({ items, inside: all }),
    stockSummaryRows({ items, before: [], inside: all, q: "" }),
    stockSummaryRows({ items, before: aggregate(rows, (r) => r.date < at("2026-04-01")), inside: all }),
  ]) {
    const upper = summary.find((r) => r.name === "Widget");
    const lower = summary.find((r) => r.name === "widget");
    assert.deepEqual([upper.opening, upper.closing], [10, 10]);
    assert.deepEqual([lower.opening, lower.closing], [0, -3]);
    assert.equal(lower.inMaster, false);
    assert.equal(lower.unit, "PCS", "the drifted line still finds its master's details");
  }
  assert.equal(movementRows({ items, rows }).at(-1).running, -3);
  assert.equal(stockOf(index, "Widget").quantity, 10);
  const val = valuationRows({ items, movements: all });
  assert.equal(val.totals.value, stockValue({ stock: index, items }).value);
});

test("an item missing from the master still appears, from zero", () => {
  const b = book();
  postInvoice(b, { invoiceNo: 1, date: "2026-04-01", type: "Sale", lines: [{ name: "Ghost", quantity: 2 }] });
  const rows = stockSummaryRows({ items: ITEMS, inside: aggregate(b.rows) });
  const ghost = rows.find((r) => r.name === "Ghost");
  assert.equal(ghost.inMaster, false);
  assert.equal(ghost.closing, -2);
});

test("movements: filters narrow the list but never the running quantity", () => {
  const b = periodBook();
  const all = movementRows({ items: ITEMS, before: before(b, "2026-04-01"), rows: b.rows, from: "2026-04-01", to: "2026-04-30" });
  assert.ok(all.every((r) => r.date >= at("2026-04-01")), "a movement outside the period was listed");
  const returns = movementRows({ items: ITEMS, before: before(b, "2026-04-01"), rows: b.rows, from: "2026-04-01", to: "2026-04-30", type: "sale-return" });
  assert.equal(returns.length, 1);
  // 30 opening (the March purchase), less 12 sold, plus 2 back = 20.
  assert.equal(returns[0].running, 20);
  assert.equal(movementRows({ items: ITEMS, rows: b.rows, ref: "3" }).length, 1, "document search");
  assert.equal(movementRows({ items: ITEMS, rows: b.rows, q: "shah" }).length, 3, "party search");
  assert.deepEqual(movementTotals(returns), { movements: 1, received: 2, issued: 0 });
});

test("movements honour IST day boundaries", () => {
  const rows = [
    { _id: "a", date: new Date("2026-03-31T19:00:00Z"), itemName: "Bolt", invoiceNo: "1", typeOfVoucher: "Purchase", receiptQuantity: 1, issueQuantity: 0 },
  ];
  // 19:00 UTC on 31 March is 00:30 IST on 1 April.
  assert.equal(movementRows({ items: ITEMS, rows, from: "2026-04-01", to: "2026-04-01" }).length, 1);
  assert.equal(movementRows({ items: ITEMS, rows, from: "2026-03-31", to: "2026-03-31" }).length, 0);
});

/* ========================================================== valuation == */

console.log("\n--- valuation ---");

test("valuation is quantity x master cost, and its total IS the balance sheet's closing stock", () => {
  const b = periodBook();
  const movements = aggregate(b.rows);
  const { rows, totals } = valuationRows({ items: ITEMS, movements });
  const fromFinancials = stockValue({ stock: buildStockIndex({ items: ITEMS, movements }), items: ITEMS });
  assert.equal(totals.value, fromFinancials.value);
  const widget = rows.find((r) => r.name === "Widget");
  assert.equal(widget.value, 400, "4 x 100");
  const bolt = rows.find((r) => r.name === "Bolt");
  assert.equal(bolt.value, 50, "20 x 2.5");
});

test("an item with stock and no cost is listed, not valued at zero", () => {
  const { rows, totals } = valuationRows({ items: ITEMS, movements: [] });
  const rod = rows.find((r) => r.name === "Steel Rod");
  assert.equal(rod.value, null);
  assert.match(rod.note, /No cost/);
  assert.ok(totals.missingCosts.includes("Steel Rod"));
  assert.equal(totals.valued + totals.missingCosts.length, totals.held);
});

test("negative stock is valued negative, as the balance sheet values it, and says so", () => {
  const { rows } = valuationRows({
    items: ITEMS,
    movements: [{ _id: "Frame", received: 0, issued: 2 }],
  });
  const frame = rows.find((r) => r.name === "Frame");
  assert.equal(frame.value, -800);
  assert.equal(frame.note, "Negative stock");
});

test("an item with no stock is not listed; an empty book values at zero", () => {
  const { rows, totals } = valuationRows({ items: [], movements: [] });
  assert.deepEqual(rows, []);
  assert.equal(totals.value, 0);
  assert.ok(!valuationRows({ items: ITEMS, movements: [] }).rows.some((r) => r.name === "Frame"));
});

test("a search narrows the rows, not the closing stock", () => {
  const movements = aggregate(periodBook().rows);
  const all = valuationRows({ items: ITEMS, movements });
  const one = valuationRows({ items: ITEMS, movements, q: "widget" });
  assert.equal(one.rows.length, 1);
  assert.ok(all.rows.length > 1, "the fixture must hold more than the searched item");
  assert.equal(one.totals.value, all.totals.value, "a search changed the closing stock");
  assert.equal(one.totals.shownValue, 400);
  assert.notEqual(one.totals.shownValue, one.totals.value);
});

test("the costing method is stated, and is not FIFO or weighted average", () => {
  assert.match(COSTING_METHOD, /Standard cost/);
  assert.match(COSTING_METHOD, /Not FIFO or weighted average/);
  const [sheet] = inventorySheets({ view: "valuation", rows: [], totals: { value: 0, valued: 0, held: 0 }, to: "2026-04-30" });
  assert.ok(sheet.meta.some((m) => m.label === "Costing method"));
});

/* ========================================================= everything == */

console.log("\n--- one figure everywhere ---");

test("dashboard index, summary closing, last running quantity and valuation quantity agree", () => {
  const b = periodBook();
  const movements = aggregate(b.rows);
  const index = buildStockIndex({ items: ITEMS, movements });
  const summary = stockSummaryRows({ items: ITEMS, inside: movements });
  const moves = movementRows({ items: ITEMS, rows: b.rows });
  const val = valuationRows({ items: ITEMS, movements }).rows;
  for (const name of ["Widget", "Bolt"]) {
    const q = stockOf(index, name).quantity;
    assert.equal(summary.find((r) => r.name === name).closing, q);
    assert.equal(moves.filter((r) => r.itemName === name).at(-1).running, q);
    assert.equal(val.find((r) => r.name === name).quantity, q);
  }
  // And the dashboard's own low-stock rule reads the same figure.
  const widgetAlert = lowStockRows({ stock: index, items: ITEMS }).find((r) => r.name === "Widget");
  assert.equal(widgetAlert.quantity, stockOf(index, "Widget").quantity);
});

test("empty datasets: every view answers, with nothing in it", () => {
  assert.deepEqual(stockSummaryRows({}), []);
  assert.deepEqual(movementRows({}), []);
  assert.deepEqual(movementTotals([]), { movements: 0, received: 0, issued: 0 });
  assert.deepEqual(valuationRows({}).rows, []);
  for (const view of ["summary", "movements", "valuation"]) {
    const [sheet] = inventorySheets({ view, rows: [], totals: {} });
    assert.ok(sheet.columns.length > 0, view);
  }
});

test("the URL keeps the report's filters", () => {
  const qs = buildReportQuery(REPORT_QUERIES.stockReport, {
    view: "movements", preset: "custom", from: "2026-04-01", to: "2026-04-30", q: "", item: "Bolt", type: "sale-return", ref: "", status: "all",
  });
  assert.equal(qs, "view=movements&preset=custom&from=2026-04-01&to=2026-04-30&item=Bolt&type=sale-return");
  assert.deepEqual(parseReportQuery(REPORT_QUERIES.stockReport, "type=bogus&status=meh").values, {});
});

/* ============================================================== wiring == */

console.log("\n--- the routes ---");

test("the stock report is read-only, tenant-wrapped, and validates what it is given", () => {
  const src = code(read("app/api/stock-report/route.js"));
  assert.match(src, /export const GET = tenantRoute\(handleGET\)/);
  assert.doesNotMatch(src, /\.(create|updateOne|updateMany|deleteMany|deleteOne|insertMany|bulkWrite)\(/, "the report writes");
  // The route is now Sigfa's five stock reports (lib/inventory.mjs, tested in
  // scripts/inventory.test.mjs). Every parameter it is given is still
  // checked against the module that owns it, and refused with a 400 rather
  // than quietly defaulted.
  assert.match(src, /isStockReport\(report\)/);
  assert.match(src, /isStockFilter\(filter\)/);
  assert.match(src, /isPreset\(preset\)/);
  assert.match(src, /isReportFormat\(format\)/);
  assert.match(src, /basisProblem\(basis\)/);
  assert.match(src, /slabProblem\(slabs\)/);
  // The period is the shared resolver's, which cuts at IST day boundaries
  // (scripts/report-periods.test.mjs).
  assert.match(src, /resolvePeriod\(/);
  // Only HTTP methods and route options may be exported from a route file.
  for (const m of src.matchAll(/^export (?:const|async function|function) (\w+)/gm)) {
    assert.ok(["GET", "POST", "dynamic"].includes(m[1]), `route exports "${m[1]}"`);
  }
});

test("the inventory pages and routes are behind report:read", () => {
  for (const path of ["/api/stock-report", "/stock-report", "/api/stock-alerts"]) {
    assert.equal(permissionForPath(path), "report:read", path);
  }
  assert.equal(canAccessPath("biller", "/stock-report"), false);
  assert.equal(canAccessPath("accountant", "/api/stock-report"), true);
});

test("back-dated stock vouchers and opening edits rewrite the running figures", () => {
  const ledger = code(read("lib/itemLedger.mjs"));
  const prod = ledger.slice(ledger.indexOf("export async function writeProductionLedgerRows"));
  assert.match(prod, /recomputeItemBalances\(\[\.\.\.movedBefore, \.\.\.rows\.map/, "the stock voucher writer does not recompute");
  assert.match(ledger.slice(ledger.indexOf("export async function deleteProductionLedgerRows")), /recomputeItemBalances\(touched, session\)/);
  assert.match(code(read("app/api/item-alter/route.js")), /await recomputeItemBalances\(\[nextName\], session\)/);
});

test("clearing the transactions has a model for every collection it lists", () => {
  // It used to refuse every clear: orders and productions were listed and
  // never wired, and the route's own guard said so.
  const src = code(read("app/api/clear-transactions/route.js"));
  const block = src.slice(src.indexOf("const MODELS = {"), src.indexOf("};", src.indexOf("const MODELS = {")));
  for (const name of TRANSACTION_COLLECTIONS) {
    assert.match(block, new RegExp(`\\b${name}:`), `no model wired for ${name}`);
  }
  assert.ok(TRANSACTION_COLLECTIONS.includes("stockalerts"));
});

test("the report page ignores a reply for filters it has already left", () => {
  const src = code(read("app/stock-report/page.js"));
  assert.match(src, /const mine = \+\+latest\.current;/);
  assert.match(src, /if \(mine !== latest\.current\) return;/);
  assert.match(src, /if \(mine === latest\.current\) setLoading\(false\)/);
  // The link is read by its own params reader (the report hub's tiles
  // preselect a sheet; scripts/report-catalogue.test.mjs checks the keys).
  assert.match(src, /<StockReportSearchParams/);
});

test("an item edit rewrites its running figures only when the opening or the name changed", () => {
  const src = code(read("app/api/item-alter/route.js"));
  assert.match(src, /if \(renamed \|\| \(Number\(existing\.openingQuantity\) \|\| 0\) !== previousOpening\)/);
});

test("the item master shows the summed stock, not 'Last Year Stock'", () => {
  const src = read("app/itemadd/page.js");
  assert.match(src, /fetch\('\/api\/item-stock'\)/);
  assert.match(src, /stockOf\(body\.stock/);
});

console.log(`\n${passed} checks passed.\n`);
