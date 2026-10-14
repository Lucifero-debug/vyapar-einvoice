/**
 * Sales and purchase challans (SIGFA's SC / PC): lib/challanStatus.mjs,
 * lib/challanInput.mjs, and how the routes and the billing screen use them.
 *
 * Bare node: `node scripts/challans.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CHALLAN_KINDS,
  applyBilled,
  billedQty,
  carryBilled,
  challanLedgerKey,
  challanLineProblems,
  challanRefsOf,
  challanStatus,
  challanStockRows,
  challanTotals,
  claimsFromItems,
  deleteBlockedReason,
  editBlockedReason,
  invoiceStockLines,
  isChallanLedgerKey,
  netClaims,
  pendingQty,
  pickFromChallans,
  pickKey,
  printableChallanRefs,
  stampChallanStock,
  toInvoiceLines,
} from "../lib/challanStatus.mjs";
import { ChallanInputError, prepareChallanInput } from "../lib/challanInput.mjs";
import { prepareInvoiceInput } from "../lib/invoiceInput.mjs";
import { movementType } from "../lib/inventoryReports.mjs";
import { STOCK_PREFIXES } from "../lib/stockVoucher.mjs";
import { permissionForPath } from "../lib/roles.mjs";
import { BILLING_SHORTCUTS } from "../lib/billingKeys.mjs";
import { TRANSACTION_COLLECTIONS } from "../lib/clearData.mjs";
import { recalcItem } from "../lib/billingMath.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const CHALLAN = {
  challanNo: 7,
  type: "Sale",
  date: "2026-10-10T00:00:00.000Z",
  customer: { name: "Gupta Hardware" },
  stockEffect: true,
  items: [
    { _id: "L1", name: "MS Angle", quantity: 10, billedQty: 0, cost: 100, discount: 0, gstRate: 18 },
    { _id: "L2", name: "MS Plate", quantity: 5, billedQty: 2, cost: 200, discount: 10, gstRate: 18 },
    { _id: "L3", name: "Fitting charge", quantity: 1, billedQty: 0, cost: 50, gstRate: 18, isService: true },
  ],
};

const BODY = {
  type: "Sale",
  date: "2026-10-10",
  customer: { name: "Gupta Hardware" },
  items: [{ name: "MS Angle", quantity: "10", cost: "100", gstRate: 18 }],
};

/* ───────────────────────────── SIGFA's two kinds ─────────────────────── */

console.log("\n--- the two kinds, as SIGFA has them ---");

test("SC Sales Challan and PC Purchase Challan, printed in capitals", () => {
  assert.equal(CHALLAN_KINDS.Sale.mkey, "SC");
  assert.equal(CHALLAN_KINDS.Purchase.mkey, "PC");
  assert.equal(CHALLAN_KINDS.Sale.label, "Sales Challan");
  assert.equal(CHALLAN_KINDS.Purchase.printTitle, "PURCHASE CHALLAN");
});

test("stock keys SC-/PC- collide with neither invoices nor stock vouchers", () => {
  assert.equal(challanLedgerKey("Sale", 7), "SC-7");
  assert.equal(challanLedgerKey("Purchase", 3), "PC-3");
  for (const p of STOCK_PREFIXES) assert.ok(!["SC-", "PC-"].includes(p));
  assert.ok(isChallanLedgerKey("SC-7") && !isChallanLedgerKey("7") && !isChallanLedgerKey("PRD-7"));
  assert.throws(() => challanLedgerKey("Sales", 1), /Not a challan type/);
});

test("the stock report names a challan's rows", () => {
  assert.equal(movementType({ invoiceNo: "SC-7", issueQuantity: 5 }), "sale-challan");
  assert.equal(movementType({ invoiceNo: "PC-2", receiptQuantity: 5 }), "purchase-challan");
});

/* ───────────────────────────── quantities ────────────────────────────── */

console.log("\n--- pending, billed, status ---");

test("pending is always quantity less billed, never stored", () => {
  assert.equal(pendingQty(CHALLAN.items[1]), 3);
  assert.equal(pendingQty({ quantity: 2, billedQty: 5 }), 0, "never negative");
});

test("pending, part billed, billed", () => {
  assert.equal(challanStatus({ items: [{ quantity: 1, billedQty: 0 }] }), "pending");
  assert.equal(challanStatus(CHALLAN), "partial");
  assert.equal(challanStatus({ items: [{ quantity: 1, billedQty: 1 }, { quantity: 2, billedQty: 2 }] }), "billed");
});

test("the value is the billing screen's own arithmetic", () => {
  const t = challanTotals(CHALLAN.items);
  // 10x100 + 5x200 less 10% + 50 = 1000 + 900 + 50 = 1950 taxable, 18% GST.
  assert.equal(t.taxable, 1950);
  assert.equal(t.gst, 351);
  assert.equal(t.total, 2301);
});

/* ───────────────────────────── stock ─────────────────────────────────── */

console.log("\n--- stock effect (SIGFA's Dsale) ---");

test("a sales challan with stock effect issues its goods; services move nothing", () => {
  const rows = challanStockRows(CHALLAN);
  assert.deepEqual(rows, [
    { itemName: "MS Angle", receiptQuantity: 0, issueQuantity: 10 },
    { itemName: "MS Plate", receiptQuantity: 0, issueQuantity: 5 },
  ]);
});

test("a purchase challan receives; no stock effect writes nothing", () => {
  const rows = challanStockRows({ ...CHALLAN, type: "Purchase" });
  assert.equal(rows[0].receiptQuantity, 10);
  assert.deepEqual(challanStockRows({ ...CHALLAN, stockEffect: false }), []);
});

test("an invoice line from a stock-moving challan writes no stock row of its own", () => {
  const lines = [{ name: "A", challanStock: true }, { name: "B", challanStock: false }, { name: "C" }];
  assert.deepEqual(invoiceStockLines(lines).map((l) => l.name), ["B", "C"]);
});

test("the stock flag comes from the CHALLAN, whatever the screen sent", () => {
  const lines = [
    { name: "MS Angle", challanNo: 7, challanType: "Sale", challanLineId: "L1", challanStock: false },
    { name: "Loose", challanStock: true },
  ];
  const stamped = stampChallanStock(lines, [CHALLAN]);
  assert.equal(stamped[0].challanStock, true);
  assert.equal("challanStock" in stamped[1], false, "a line on no challan carries no flag");
});

/* ───────────────────────────── billing ───────────────────────────────── */

console.log("\n--- billing a challan ---");

const billLine = (lineId, quantity, name = "MS Angle") => ({
  name,
  quantity,
  challanNo: 7,
  challanType: "Sale",
  challanLineId: lineId,
});

test("claims group by challan and line", () => {
  const groups = claimsFromItems([billLine("L1", 4), billLine("L1", 2), billLine("L2", 1, "MS Plate"), { name: "x", quantity: 3 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].byLine.get("L1"), 6);
  assert.equal(groups[0].byLine.get("L2"), 1);
  assert.deepEqual(challanRefsOf([billLine("L1", 1)]), [{ challanNo: 7, type: "Sale" }]);
});

test("an edit moves the challan by the difference only", () => {
  const net = netClaims([billLine("L1", 4)], [billLine("L1", 6), billLine("L2", 1, "MS Plate")]);
  assert.equal(net[0].byLine.get("L1"), 2);
  assert.equal(net[0].byLine.get("L2"), 1);
  assert.deepEqual(netClaims([billLine("L1", 4)], [billLine("L1", 4)]), []);
});

test("billing is applied, and billing more than the challan carried is refused", () => {
  const ok = applyBilled(CHALLAN, new Map([["L1", 10], ["L2", 3]]));
  assert.deepEqual(ok.problems, []);
  assert.equal(challanStatus({ items: ok.items }), "partial", "L3 is still pending");
  const over = applyBilled(CHALLAN, new Map([["L2", 4]]));
  assert.match(over.problems[0], /only 3 left to bill of 5/);
  const under = applyBilled(CHALLAN, new Map([["L2", -3]]));
  assert.match(under.problems[0], /cannot un-bill 3 when only 2/);
  assert.match(applyBilled(CHALLAN, new Map([["GONE", 1]])).problems[0], /no longer exists/);
});

test("a bill's challan lines must be this side's, this party's, this item's", () => {
  const items = [billLine("L1", 1)];
  assert.deepEqual(challanLineProblems(items, [CHALLAN], { invoiceType: "Sale", partyName: "gupta hardware" }), []);
  assert.match(challanLineProblems(items, [], {})[0], /Sales Challan 7 does not exist/);
  assert.match(challanLineProblems(items, [CHALLAN], { partyName: "Someone Else" })[0], /is for "Gupta Hardware"/);
  assert.match(challanLineProblems([billLine("L1", 1, "MS Plate")], [CHALLAN], {})[0], /carried "MS Angle"/);
  assert.match(challanLineProblems([billLine("NOPE", 1)], [CHALLAN], {})[0], /not on Sales Challan 7/);
});

test("one bill does not mix challans that did and did not move stock (SIGFA's 'Same Effect Value')", () => {
  const other = { ...CHALLAN, challanNo: 8, stockEffect: false };
  const items = [billLine("L1", 1), { ...billLine("L1", 1), challanNo: 8 }];
  const problems = challanLineProblems(items, [CHALLAN, other], {});
  assert.match(problems.at(-1), /cannot mix challans that moved stock/);
});

test("pending lines become invoice lines carrying their challan reference", () => {
  const lines = toInvoiceLines(CHALLAN);
  assert.deepEqual(lines.map((l) => [l.name, l.quantity]), [["MS Angle", 10], ["MS Plate", 3], ["Fitting charge", 1]]);
  assert.equal(lines[1].challanLineId, "L2");
  assert.equal(lines[1].challanNo, 7);
  assert.equal(lines[1].total, recalcItem({ cost: 200, quantity: 3, discount: 10, gstRate: 18 }).total);
});

test("the picker refuses more than pending, a mix of effects, and a mix of parties", () => {
  const pending = { ...CHALLAN, lines: toInvoiceLines(CHALLAN) };
  const ok = pickFromChallans({ challans: [pending], picks: { [pickKey(pending, pending.lines[1])]: 2 } });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.lines.length, 1);
  assert.equal(ok.lines[0].quantity, 2);
  assert.equal(ok.used[0].party, "Gupta Hardware");

  const over = pickFromChallans({ challans: [pending], picks: { [pickKey(pending, pending.lines[1])]: 4 } });
  assert.match(over.problems[0], /only 3 is pending/);
  assert.deepEqual(over.lines, []);

  const other = { ...pending, challanNo: 9, stockEffect: false, customer: { name: "Mehta" } };
  other.lines = toInvoiceLines({ ...CHALLAN, challanNo: 9 });
  const mixed = pickFromChallans({
    challans: [pending, other],
    picks: { [pickKey(pending, pending.lines[0])]: 1, [pickKey(other, other.lines[0])]: 1 },
  });
  assert.ok(mixed.problems.some((p) => /moved stock and challans that did not/.test(p)));
  assert.ok(mixed.problems.some((p) => /different parties/.test(p)));
});

test("the picker never puts the item master's own id on a bill line", () => {
  const pending = { ...CHALLAN, lines: toInvoiceLines(CHALLAN) };
  const { lines } = pickFromChallans({
    challans: [pending],
    picks: { [pickKey(pending, pending.lines[0])]: 1 },
    items: [{ _id: "ITEM-ID", name: "MS Angle", uqc: "KGS" }],
  });
  assert.equal(lines[0]._id, undefined);
  assert.equal(lines[0].uqc, "KGS");
});

test("the printed bill lists its challans", () => {
  const refs = printableChallanRefs({ items: [{ ...billLine("L1", 1), challanDate: "2026-10-10" }, billLine("L2", 1)] });
  assert.deepEqual(refs, [{ challanNo: 7, date: "2026-10-10" }]);
});

/* ───────────────────────── edit and delete guards ────────────────────── */

console.log("\n--- what a billed challan protects ---");

test("a billed challan cannot be deleted; an unbilled one can", () => {
  assert.match(deleteBlockedReason(CHALLAN), /already been billed/);
  assert.equal(deleteBlockedReason({ ...CHALLAN, items: [{ quantity: 1, billedQty: 0 }] }), null);
});

test("a billed line keeps its item and at least the billed quantity; party and effect are fixed", () => {
  const next = (over) => ({ ...CHALLAN, ...over });
  assert.equal(editBlockedReason(CHALLAN, next({})), null);
  assert.match(editBlockedReason(CHALLAN, next({ items: CHALLAN.items.filter((l) => l._id !== "L2") })), /cannot be removed/);
  assert.match(
    editBlockedReason(CHALLAN, next({ items: CHALLAN.items.map((l) => (l._id === "L2" ? { ...l, quantity: 1 } : l)) })),
    /cannot go below the 2 already billed/
  );
  assert.match(editBlockedReason(CHALLAN, next({ customer: { name: "Other" } })), /party cannot change/);
  assert.match(editBlockedReason(CHALLAN, next({ stockEffect: false })), /stock effect cannot change/);
  // An unbilled line may still be removed.
  assert.equal(editBlockedReason(CHALLAN, next({ items: CHALLAN.items.filter((l) => l._id !== "L1") })), null);
});

test("an id the challan never had, or one used twice, is a new line with nothing billed", () => {
  const items = carryBilled(CHALLAN.items, [
    { _id: "L2", name: "MS Plate", quantity: 3 },
    { _id: "L2", name: "MS Plate", quantity: 10 },
    { _id: "FORGED", name: "MS Plate", quantity: 1 },
  ]);
  assert.equal(billedQty(items[0]), 2);
  assert.equal(billedQty(items[1]), 0);
  assert.equal(items[1]._id, undefined, "the second use of an id is dropped");
  assert.equal(items[2]._id, undefined);
});

test("a line id must be a database id, and listed once", () => {
  const id = "a".repeat(24);
  assert.throws(() => prepareChallanInput({ ...BODY, items: [{ ...BODY.items[0], _id: "L1" }] }), /not a line of this challan/);
  assert.throws(
    () => prepareChallanInput({ ...BODY, items: [{ ...BODY.items[0], _id: id }, { ...BODY.items[0], _id: id }] }),
    /listed twice/
  );
  assert.equal(prepareChallanInput({ ...BODY, items: [{ ...BODY.items[0], _id: id }] }).items[0]._id, id);
});

test("a zero-rate challan line bills at zero, not at the item's price", () => {
  const free = { ...CHALLAN, items: [{ _id: "F1", name: "Sample", quantity: 2, billedQty: 0, cost: 0, gstRate: 18 }] };
  const pending = { ...free, lines: toInvoiceLines(free) };
  const { lines } = pickFromChallans({
    challans: [pending],
    picks: { [pickKey(pending, pending.lines[0])]: 2 },
    items: [{ name: "Sample", salePrice: 500, purchasePrice: 300 }],
    recalc: recalcItem,
  });
  assert.equal(lines[0].cost, 0);
  assert.equal(lines[0].total, 0);
});

test("renaming a party or an item carries into its challans", () => {
  assert.match(read("../app/api/customer-alter/route.js"), /Challan\.updateMany\(\s*\{ "customer\.name": previousName \}/);
  assert.match(read("../app/api/item-alter/route.js"), /Challan\.updateMany\(\s*\{ "items\.name": previousName \}/);
});

test("an alteration that does not mention the stock effect keeps the stored one", () => {
  assert.match(code(read("../app/api/challan-alter/route.js")), /if \(body\.stockEffect === undefined\) input\.stockEffect = Boolean\(previous\.stockEffect\)/);
});

test("a challan an invoice still points at cannot be deleted, whatever the billed figures say", () => {
  assert.match(code(read("../app/api/delete-challan/route.js")), /Invoice\.findOne\(\s*\{ "items\.challanNo": challanNo, "items\.challanType": type \}/);
});

test("an edit keeps the STORED billed figure, never the screen's", () => {
  const items = carryBilled(CHALLAN.items, [
    { _id: "L2", name: "MS Plate", quantity: 6, billedQty: 0 },
    { name: "New line", quantity: 1, billedQty: 99 },
  ]);
  assert.equal(billedQty(items[0]), 2);
  assert.equal(billedQty(items[1]), 0);
});

/* ───────────────────────────── input ─────────────────────────────────── */

console.log("\n--- what the server accepts ---");

test("a challan is checked and its figures recomputed", () => {
  const input = prepareChallanInput(BODY, { now: Date.parse("2026-10-14") });
  assert.equal(input.type, "Sale");
  assert.equal(input.items[0].total, 1180);
  assert.equal(input.stockEffect, true, "SIGFA's 'Stock Effect With Challan' default");
  assert.equal(prepareChallanInput({ ...BODY, stockEffect: false }).stockEffect, false);
});

test("billed quantities, totals and status are never taken from a request", () => {
  for (const key of ["billedQty", "status", "totalAmount", "companyId"]) {
    assert.throws(() => prepareChallanInput({ ...BODY, [key]: 1 }), ChallanInputError);
  }
  assert.throws(() => prepareChallanInput({ ...BODY, nonsense: 1 }), /not a challan field/);
  const line = prepareChallanInput({ ...BODY, items: [{ ...BODY.items[0], billedQty: 9 }] }).items[0];
  assert.equal("billedQty" in line, false);
});

test("bad input is refused in words", () => {
  assert.throws(() => prepareChallanInput({ ...BODY, type: "Sales" }), /Sale or a Purchase/);
  assert.throws(() => prepareChallanInput({ ...BODY, customer: {} }), /Choose the customer/);
  assert.throws(() => prepareChallanInput({ ...BODY, items: [] }), /at least one item/);
  assert.throws(() => prepareChallanInput({ ...BODY, items: [{ name: "X", quantity: 0 }] }), /more than zero/);
  assert.throws(() => prepareChallanInput({ ...BODY, stockEffect: "yes" }), /yes or no/);
});

test("an invoice line keeps its challan reference, and refuses a bad one", () => {
  const body = {
    type: "Sale",
    return: false,
    date: "2026-10-12",
    customer: { name: "Gupta Hardware" },
    paymentType: "Credit",
    received: 0,
    items: [{ name: "MS Angle", quantity: 2, cost: 100, gstRate: 18, challanNo: 7, challanType: "Sale", challanLineId: "L1", challanStock: false }],
  };
  const now = Date.parse("2026-10-14");
  const result = prepareInvoiceInput(body, { now });
  assert.equal(result.ok, true, result.error);
  const line = result.invoice.items[0];
  assert.equal(line.challanNo, 7);
  assert.equal(line.challanLineId, "L1");
  assert.equal("challanStock" in line, false, "the route sets it from the challan");

  // The validator answers { ok: false, error } rather than throwing.
  const refused = (b) => prepareInvoiceInput(b, { now });
  const half = refused({ ...body, items: [{ ...body.items[0], challanType: undefined }] });
  assert.equal(half.ok, false);
  assert.match(half.error, /challan reference is incomplete/);
  assert.match(refused({ ...body, type: "Purchase" }).error, /cannot bill a Sale challan/);
  assert.match(refused({ ...body, return: true }).error, /return cannot bill a challan/);
  const both = refused({ ...body, items: [{ ...body.items[0], orderNo: 3, orderType: "Sale", orderLineId: "O1" }] });
  assert.match(both.error, /an order or a challan, not both/);
});

/* ───────────────────────────── the wiring ────────────────────────────── */

console.log("\n--- the routes, the screen and the books ---");

const save = code(read("../app/api/save-invoice/route.js"));
const alter = code(read("../app/api/sale-alter/route.js"));
const del = code(read("../app/api/delete-invoice/route.js"));

test("save-invoice checks the challans, stamps their stock flag, skips their stock, then claims", () => {
  const check = save.indexOf("challanLineProblems(input.items, challans");
  const stamp = save.indexOf("input.items = stampChallanStock(input.items, challans)");
  const create = save.indexOf("Invoice.create(");
  const stock = save.indexOf("items: invoiceStockLines(input.items)");
  const claim = save.indexOf("claimChallanQty({ session, items: invoice.items })");
  assert.ok(check > 0 && stamp > check && create > stamp, "checked and stamped before the invoice is written");
  assert.ok(stock > create && claim > stock);
});

test("sale-alter and delete-invoice move challans by the difference / give them back", () => {
  assert.match(alter, /invoiceData\.items = stampChallanStock\(invoiceData\.items, challans\)/);
  assert.match(alter, /items: invoiceStockLines\(invoiceData\.items\)/);
  assert.match(alter, /reconcileChallanQty\(\{\s*session,\s*before: previousInvoice\.items,\s*after: updatedInvoice\.items/);
  assert.match(del, /releaseChallanQty\(\{ session, items: deletedInvoice\.items \}\)/);
});

test("only lib/challanClaims.mjs writes billed quantities", () => {
  for (const src of [save, alter, del]) assert.doesNotMatch(src, /billedQty/);
});

test("the challan routes write stock in the same transaction, and refuse what SIGFA refuses", () => {
  const add = code(read("../app/api/challan-add/route.js"));
  const alt = code(read("../app/api/challan-alter/route.js"));
  const rm = code(read("../app/api/delete-challan/route.js"));
  assert.match(add, /billedQty: 0/);
  assert.match(add, /writeChallanLedgerRows\(\{ session/);
  assert.match(alt, /carryBilled\(previous\.items, input\.items\)/);
  assert.match(alt, /editBlockedReason\(previous/);
  assert.match(alt, /writeChallanLedgerRows\(\{ session/);
  assert.match(rm, /deleteBlockedReason\(existing\)/);
  assert.match(rm, /deleteChallanLedgerRows\(\{ session/);
});

test("challans take the invoice permissions", () => {
  for (const path of ["/api/challan", "/api/get-challan", "/api/challan-pending", "/challan", "/challan/print"]) {
    assert.equal(permissionForPath(path), "invoice:read", path);
  }
  for (const path of ["/api/challan-add", "/api/challan-alter", "/api/delete-challan", "/api/next-challan-no", "/challanadd"]) {
    assert.equal(permissionForPath(path), "invoice:write", path);
  }
});

test("Pending Challan has a key (SIGFA's Alt+H is help here, so Alt+L), and the screen binds it", () => {
  const key = BILLING_SHORTCUTS.find((s) => s.action === "pendingChallan");
  assert.deepEqual(key.keys, ["Alt+L"]);
  assert.match(key.sigfa, /Pending Challan \[ Alt \+ H \]/);
  const screen = code(read("../components/billing/BillingScreen.jsx"));
  assert.match(screen, /pendingChallan: billsFromChallan \? \(\) => setShowChallanPicker\(true\) : undefined/);
  assert.match(screen, /const billsFromChallan = !config\.isReturn/);
});

test("clearing the books clears challans too", () => {
  assert.ok(TRANSACTION_COLLECTIONS.includes("challans"));
  assert.match(read("../app/api/clear-transactions/route.js"), /challans: Challan/);
  assert.match(read("../scripts/sync-indexes.mjs"), /\["challans", "challanModel"\]/);
});

test("the model keeps billedQty and the stock flag, and is unique per firm and kind", () => {
  const model = read("../models/challanModel.js");
  assert.match(model, /billedQty: \{ type: Number, default: 0 \}/);
  assert.match(model, /stockEffect: \{ type: Boolean, default: true \}/);
  assert.match(model, /\{ companyId: 1, type: 1, challanNo: 1 \}, \{ unique: true \}/);
  assert.match(model, /plugin\(tenantPlugin\)/);
  const invoice = read("../models/invoiceModel.js");
  for (const f of ["challanNo", "challanType", "challanLineId", "challanDate", "challanStock"]) {
    assert.match(invoice, new RegExp(`${f}:\\{type:`), f);
  }
});

console.log(`\n  ${passed} checks passed\n`);
