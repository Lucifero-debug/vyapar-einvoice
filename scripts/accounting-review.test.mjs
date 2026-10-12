/**
 * Regression tests for the accounting-correctness review: five defects that
 * were reported together, each pinned here so it cannot come back.
 *
 *   1. HSN/GST aggregation -- one grouping (code AND rate) for the screen,
 *      the stored hsnTotals, the print, the GL and the GST returns
 *   2. Rounding -- money summed raw and rounded once per group, CGST/SGST
 *      halved once per group
 *   3. Purchase pricing -- a purchase line starts from the master's
 *      purchase price, a sale line from its sale price
 *   4. Draft isolation -- the read-in bill hand-off names its screen, firm
 *      and user, and the browser-wide localStorage keys are gone
 *   5. Bill-wise adjustment -- an invoice a voucher has settled cannot be
 *      deleted, renumbered, moved or cut below what was settled
 *
 * Bare node, like every other test here: `node scripts/accounting-review.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildHsnSummary,
  hsnGrandTotal,
  hsnKey,
  hsnRateGroups,
  hsnTotalsForStorage,
} from "../lib/hsnTotals.mjs";
import { buildHsnTotals, hsnTotalsArray, recalcItem } from "../lib/billingMath.mjs";
import { lineTotals, glDeltas } from "../lib/invoiceGl.mjs";
import { hsnRows, rateGroups } from "../lib/gstReturns.mjs";
import { invoiceTotals } from "../lib/invoiceInput.mjs";
import { masterRateFor, resolveItemPricing } from "../lib/priceList.mjs";
import {
  IMPORT_TARGET,
  importParcel,
  importParcelVerdict,
  importScopeOf,
} from "../lib/invoiceImport.mjs";
import { allocatedToBill, settledBillProblem } from "../lib/billAdjust.mjs";
import { BILLING_TYPES } from "../lib/billingTypes.mjs";

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
/** Source with comments stripped, so a comment cannot satisfy a wiring check. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

/** A line as the billing screen produces it -- unrounded, as recalcItem leaves it. */
const line = (over = {}) =>
  recalcItem({ name: "Steel angle", hsn: "7308", quantity: 1, cost: 100, gstRate: 18, ...over });

/* ───────────────────────── 1. HSN / GST aggregation ─────────────────────── */

console.log("\n--- 1. one HSN grouping, by code AND rate ---");

const MIXED = [
  line({ name: "Bolt", hsn: "7318", cost: 100, gstRate: 5 }),
  line({ name: "Angle", hsn: "7318", cost: 200, gstRate: 18 }),
  line({ name: "Book", hsn: "4901", cost: 50, gstRate: 0 }),
  line({ name: "Nut", hsn: "7318", cost: 40, gstRate: 5 }),
];

test("one HSN at two rates is two groups, each with its own rate and tax", () => {
  const groups = hsnRateGroups(MIXED);
  assert.deepEqual(
    groups.map((g) => [g.hsn, g.gstRate, g.taxable, g.gstAmount]),
    [
      ["7318", 5, 140, 7],
      ["7318", 18, 200, 36],
      ["4901", 0, 50, 0],
    ]
  );
});

test("the screen, the stored rows, the print and the GL agree group for group", () => {
  const screen = buildHsnTotals(MIXED);
  const stored = hsnTotalsArray(screen);
  const printed = Object.values(buildHsnSummary(MIXED));
  const storage = hsnTotalsForStorage(MIXED);
  assert.deepEqual(stored, storage, "client payload and backfill derive the same rows");
  assert.deepEqual(
    printed.map((g) => [g.hsn, g.gstRate, g.gstAmount, g.total]),
    stored.map((r) => [r.hsn, r.gstRate, r.amount, r.total])
  );
  const grand = hsnGrandTotal(buildHsnSummary(MIXED));
  assert.deepEqual(lineTotals({ items: MIXED }), { taxable: grand.taxable, tax: grand.gstAmount });
});

test("what the server stores on the invoice is the per-rate grouping", () => {
  const { hsnTotals } = invoiceTotals({ items: MIXED });
  assert.deepEqual(
    hsnTotals.map((r) => [r.hsn, r.gstRate, r.amount]),
    [
      ["7318", 5, 7],
      ["7318", 18, 36],
      ["4901", 0, 0],
    ]
  );
});

test("table 12 of GSTR-1 files the same groups the bill printed", () => {
  const invoice = { type: "Sale", taxType: "local", items: MIXED };
  const rows = hsnRows([invoice]);
  const printed = Object.values(buildHsnSummary(MIXED));
  for (const g of printed) {
    const row = rows.find((r) => r.hsn_sc === g.hsn && r.rt === g.gstRate);
    assert.ok(row, `no table-12 row for ${g.hsn} @ ${g.gstRate}`);
    assert.equal(row.txval, g.taxable);
    assert.equal(sum([row.camt, row.samt]), g.gstAmount);
  }
  assert.equal(rows.length, printed.length);
});

test("several HSN codes keep apart, and a blank HSN is grouped, not dropped", () => {
  const items = [line({ hsn: "" }), line({ hsn: "8471" }), line({ hsn: undefined })];
  const keys = Object.keys(buildHsnSummary(items));
  assert.deepEqual(keys, [hsnKey("N/A", 18), hsnKey("8471", 18)]);
  // The returns never file the placeholder as an HSN code.
  const rows = hsnRows([{ type: "Sale", taxType: "local", items }]);
  assert.deepEqual(rows.map((r) => r.hsn_sc).sort(), ["", "8471"]);
});

test("the print's totals box is the HSN table's own footing", () => {
  const src = code(read("../components/InvoiceDocument.jsx"));
  assert.match(src, /const totalGstAmount = hsnGrand\.gstAmount/);
  assert.match(src, /const totalTaxableAmount = hsnGrand\.taxable/);
  assert.doesNotMatch(src, /hsnRows\.map\(\(\[/, "rows are rendered by data.hsn, not by the key");
});

test("every summary goes through the one grouping function", () => {
  for (const file of ["../lib/billingMath.mjs", "../lib/gstReturns.mjs"]) {
    assert.match(code(read(file)), /hsnRateGroups\(/, `${file} groups on its own`);
  }
  assert.match(code(read("../lib/invoiceGl.mjs")), /buildHsnSummary\(/);
});

/* ───────────────────────────── 2. rounding ──────────────────────────────── */

console.log("\n--- 2. rounding at the group, not at the line ---");

const THIRDS = [1, 2, 3].map(() => line({ hsn: "4901", cost: 100 / 3, gstRate: 5 }));

test("lines keep their dust; the group is rounded once", () => {
  // recalcItem is deliberately unrounded (lib/billingMath.mjs quirk 1).
  assert.notEqual(THIRDS[0].taxableAmount, 33.33);
  const [g] = hsnRateGroups(THIRDS);
  assert.equal(g.taxable, 100, "33.333.. x 3 is 100.00, not 99.99");
  assert.equal(g.gstAmount, 5);
  assert.equal(g.total, 105);
});

test("a return's rate group is summed raw and rounded once", () => {
  const [g] = rateGroups({ taxType: "central", items: THIRDS });
  assert.equal(g.itm_det.txval, 100, "rounding each line would file 99.99");
  assert.equal(g.itm_det.iamt, 5);
});

test("CGST and SGST are halved once per invoice group in table 12, as in table 4", () => {
  // Two lines of 0.05 tax each. Halved per line: 0.03 + 0.03 CGST and 0.02 +
  // 0.02 SGST. Halved once: 0.05 and 0.05 -- what the rate group files.
  const tiny = [1, 2].map(() =>
    ({ hsn: "9999", gstRate: 5, quantity: 1, taxableAmount: 1, gstAmount: 0.05, total: 1.05 })
  );
  const invoice = { type: "Sale", taxType: "local", items: tiny };
  const [row] = hsnRows([invoice]);
  const [group] = rateGroups(invoice);
  assert.equal(row.camt, group.itm_det.camt);
  assert.equal(row.samt, group.itm_det.samt);
  assert.equal(sum([row.camt, row.samt]), 0.1);
});

test("tables 4-7 equal the sum of table 12 when several HSN codes share a rate", () => {
  // Three codes at 5%, each line's tax 0.5025. Rounded once per rate the
  // rate group said 1.51 while table 12 said 0.50 x 3 = 1.50.
  for (const items of [
    ["7318", "7308", "7307"].map((hsn) => line({ hsn, cost: 10.05, gstRate: 5 })),
    ["7318", "7308"].map((hsn) => line({ hsn, cost: 33.335, gstRate: 18 })),
  ]) {
    for (const taxType of ["local", "central"]) {
      const invoice = { type: "Sale", taxType, items };
      const groups = rateGroups(invoice);
      const rows = hsnRows([invoice]);
      for (const g of groups) {
        const at = rows.filter((r) => r.rt === g.itm_det.rt);
        assert.equal(sum(at.map((r) => r.txval)), g.itm_det.txval, `taxable @${g.itm_det.rt}`);
        assert.equal(
          sum(at.map((r) => r.iamt + r.camt + r.samt)),
          sum([g.itm_det.iamt, g.itm_det.camt, g.itm_det.samt]),
          `tax @${g.itm_det.rt} (${taxType})`
        );
      }
      // And both agree with the printed bill's footing.
      const grand = hsnGrandTotal(buildHsnSummary(items));
      assert.equal(sum(groups.map((g) => g.itm_det.txval)), grand.taxable);
    }
  }
});

test("the GL tax is the rounded group total, and its CGST/SGST legs add back to it", () => {
  const invoice = {
    type: "Sale",
    taxType: "local",
    customer: { name: "Acme" },
    items: THIRDS,
    finalAmount: 105,
  };
  const { moves, tax: glTax, difference } = glDeltas(invoice);
  assert.equal(glTax, 5);
  assert.equal(difference, 0, "nothing left for the round-off");
  const total = sum(moves.map((m) => m.delta));
  assert.equal(total, 0, "the posting balances");
  const tax = moves.filter((m) => /gst/i.test(m.account)).map((m) => -m.delta);
  assert.equal(sum(tax), 5);
});

test("the stored hsnTotals carry paise, not float dust", () => {
  const [row] = hsnTotalsArray(buildHsnTotals(THIRDS));
  for (const v of [row.amount, row.total]) {
    assert.equal(v, Math.round(v * 100) / 100);
  }
});

/* ──────────────────────────── 3. pricing ────────────────────────────────── */

console.log("\n--- 3. a purchase starts from the purchase price ---");

const ITEM = { _id: "i1", name: "Bolt", salePrice: 120, purchasePrice: 90, discount: 2, unit: "PCS" };

test("a sale line starts from the sale price", () => {
  assert.equal(resolveItemPricing(ITEM, null, { side: "Sale" }).rate, 120);
  assert.equal(resolveItemPricing(ITEM, null).rate, 120, "no side is the old sale behaviour");
});

test("a purchase line starts from the purchase price", () => {
  assert.equal(resolveItemPricing(ITEM, null, { side: "Purchase" }).rate, 90);
});

test("no purchase price set: a purchase falls back to the sale price, never to zero", () => {
  for (const purchasePrice of [undefined, null, "", 0]) {
    assert.equal(masterRateFor({ ...ITEM, purchasePrice }, "Purchase"), 120, String(purchasePrice));
  }
});

test("a party's price list still wins on either side", () => {
  const list = { items: [{ itemId: "i1", salePrice: 100 }] };
  assert.equal(resolveItemPricing(ITEM, list, { side: "Sale" }).rate, 100);
  assert.equal(resolveItemPricing(ITEM, list, { side: "Purchase" }).rate, 100);
  // A row with no rate falls back to the SIDE's master rate.
  const discountOnly = { items: [{ itemId: "i1", discount: 5 }] };
  assert.equal(resolveItemPricing(ITEM, discountOnly, { side: "Purchase" }).rate, 90);
});

test("returns price like their direction", () => {
  assert.equal(BILLING_TYPES.purchasereturn.type, "Purchase");
  assert.equal(resolveItemPricing(ITEM, null, { side: BILLING_TYPES.purchasereturn.type }).rate, 90);
  assert.equal(resolveItemPricing(ITEM, null, { side: BILLING_TYPES.salereturn.type }).rate, 120);
});

test("the billing screen tells the pricing which side it is", () => {
  const src = code(read("../components/billing/BillingScreen.jsx"));
  assert.match(src, /resolveItemPricing\([\s\S]{0,200}\{ side: config\.type \}/);
});

/* ─────────────────────────── 4. draft isolation ─────────────────────────── */

console.log("\n--- 4. a read-in bill lands only where it was meant to ---");

const ME = { user: { email: "Clerk@Firm-A.in" }, company: { id: "companyA" } };
const SCOPE = importScopeOf(ME);
const PARCEL = importParcel({ draft: { lines: [{ name: "Bolt" }] }, warnings: [] }, SCOPE);
const PURCHASE = { type: "Purchase", isReturn: false, scope: SCOPE };

test("the parcel names its screen and its owner", () => {
  assert.deepEqual(PARCEL.target, { ...IMPORT_TARGET });
  assert.deepEqual(PARCEL.scope, { companyId: "companyA", user: "clerk@firm-a.in" });
  assert.equal(importScopeOf({ user: { email: "x" } }), null, "no firm, no owner");
  assert.equal(importScopeOf(null), null);
});

test("applied on the purchase screen, by the same firm and user", () => {
  assert.equal(importParcelVerdict(PARCEL, PURCHASE), "ok");
  // A round trip through sessionStorage changes nothing.
  assert.equal(importParcelVerdict(JSON.parse(JSON.stringify(PARCEL)), PURCHASE), "ok");
});

test("not on the other three screens", () => {
  for (const key of ["sale", "salereturn", "purchasereturn"]) {
    const t = BILLING_TYPES[key];
    assert.equal(
      importParcelVerdict(PARCEL, { type: t.type, isReturn: t.isReturn, scope: SCOPE }),
      "wrong-screen",
      key
    );
  }
});

test("not for another company, nor another user of the same company", () => {
  const otherFirm = importScopeOf({ ...ME, company: { id: "companyB" } });
  const otherUser = importScopeOf({ ...ME, user: { email: "owner@firm-a.in" } });
  assert.equal(importParcelVerdict(PARCEL, { ...PURCHASE, scope: otherFirm }), "wrong-owner");
  assert.equal(importParcelVerdict(PARCEL, { ...PURCHASE, scope: otherUser }), "wrong-owner");
});

test("an untagged parcel from before the check is nobody's", () => {
  const legacy = { draft: PARCEL.draft, warnings: [] };
  assert.equal(importParcelVerdict(legacy, PURCHASE), "wrong-owner");
});

test("unknown signer: not applied, but kept for a retry", () => {
  assert.equal(importParcelVerdict(PARCEL, { ...PURCHASE, scope: null }), "unverified");
  assert.equal(importParcelVerdict(null, PURCHASE), "missing");
  assert.equal(importParcelVerdict({}, PURCHASE), "missing");
});

test("the screen removes the parcel only when it is used or can never be", () => {
  const src = code(read("../components/billing/BillingScreen.jsx"));
  assert.match(src, /importParcelVerdict\(parcel, \{\s*type: config\.type,\s*isReturn: config\.isReturn,\s*scope,/);
  const guard = src.slice(src.indexOf("const verdict = importParcelVerdict"), src.indexOf("sessionStorage.removeItem(IMPORT_DRAFT_KEY)"));
  assert.match(guard, /verdict === 'ok' \|\| verdict === 'wrong-owner' \|\| verdict === 'missing'/);
  // And nothing is applied until the verdict is ok.
  const from = src.indexOf("if (verdict !== 'ok')");
  const apply = src.indexOf("setSelectedItem(draft.lines)");
  assert.ok(from > 0 && apply > from, "the draft is applied before the check");
});

test("the upload page tags the parcel with who read it", () => {
  const src = code(read("../app/upload/page.js"));
  assert.match(src, /importParcel\(/);
  assert.match(src, /importScopeOf\(/);
  assert.match(src, /\/api\/auth\/me/);
});

test("the draft is tagged with who READ the photo, checked again on the way out", () => {
  const src = code(read("../app/upload/page.js"));
  // Captured with the read, since the server matched the bill against that
  // firm's masters...
  const readFn = src.slice(src.indexOf("const read = useCallback"), src.indexOf("const openInForm"));
  assert.match(readFn, /whoAmI\(\)/);
  assert.match(readFn, /setReadBy\(scope\)/);
  // ...and compared with whoever is signed in when the form is opened.
  const open = src.slice(src.indexOf("const openInForm"));
  assert.match(open, /scope\.companyId !== readBy\.companyId/);
  assert.match(open, /scope\.user !== readBy\.user/);
});

test("no billing screen shares browser-wide draft keys any more", () => {
  const src = code(read("../components/billing/BillingScreen.jsx"));
  assert.doesNotMatch(src, /localStorage/, "a bare localStorage key is shared by every screen, firm and user");
  assert.doesNotMatch(src, /localStorageHelper/);
});

/* ───────────────────────── 5. bill-wise adjustment ──────────────────────── */

console.log("\n--- 5. a settled bill cannot move out from under its vouchers ---");

const BILL = { invoiceNo: 7, type: "Sale", return: false, customer: { name: "Acme" }, balanceDue: 1000 };
const VOUCHERS = [
  {
    acName: "Cash",
    date: "2026-09-01",
    customers: [
      { name: "Acme", credit: 300, allocations: [{ invoiceNo: 7, invoiceType: "Sale", amount: 300 }] },
      // Purchase 7 is a different bill.
      { name: "Acme", debit: 50, allocations: [{ invoiceNo: 7, invoiceType: "Purchase", amount: 50 }] },
    ],
  },
  {
    acName: "HDFC Bank",
    date: "2026-09-10",
    customers: [
      { name: "Acme", credit: 200.5, allocations: [{ invoiceNo: 7, invoiceType: "Sale", amount: 200.5 }] },
    ],
  },
  { acName: "Cash", customers: [{ name: "Other", credit: 10 }] },
];

test("what is settled against a bill is summed by type AND number, across vouchers", () => {
  const sale = allocatedToBill(VOUCHERS, { invoiceNo: 7, invoiceType: "Sale" });
  assert.equal(sale.allocated, 500.5);
  assert.deepEqual(sale.vouchers.map((v) => v.acName), ["Cash", "HDFC Bank"]);
  assert.equal(allocatedToBill(VOUCHERS, { invoiceNo: 7, invoiceType: "Purchase" }).allocated, 50);
  assert.equal(allocatedToBill(VOUCHERS, { invoiceNo: 8, invoiceType: "Sale" }).allocated, 0);
});

const settled = allocatedToBill(VOUCHERS, { invoiceNo: 7, invoiceType: "Sale" });

test("a settled bill cannot be deleted", () => {
  const why = settledBillProblem({ before: BILL, after: null, ...settled });
  assert.match(why, /500\.50 has been adjusted against invoice 7/);
  assert.match(why, /Cash, HDFC Bank/);
});

test("nor renumbered, retyped, made a return, or moved to another party", () => {
  for (const change of [
    { invoiceNo: 8 },
    { type: "Purchase" },
    { return: true },
    { customer: { name: "Acme Traders" } },
  ]) {
    assert.ok(
      settledBillProblem({ before: BILL, after: { ...BILL, ...change }, ...settled }),
      JSON.stringify(change)
    );
  }
});

test("nor cut below what has been settled -- down to it is fine", () => {
  assert.ok(settledBillProblem({ before: BILL, after: { ...BILL, balanceDue: 500 }, ...settled }));
  assert.equal(settledBillProblem({ before: BILL, after: { ...BILL, balanceDue: 500.5 }, ...settled }), null);
  assert.equal(settledBillProblem({ before: BILL, after: { ...BILL, balanceDue: 1200 }, ...settled }), null);
});

test("an unsettled bill is as free as it always was", () => {
  const none = allocatedToBill(VOUCHERS, { invoiceNo: 9, invoiceType: "Sale" });
  assert.equal(settledBillProblem({ before: { ...BILL, invoiceNo: 9 }, after: null, ...none }), null);
  assert.equal(
    settledBillProblem({ before: { ...BILL, invoiceNo: 9 }, after: { ...BILL, invoiceNo: 10, customer: { name: "B" } }, ...none }),
    null
  );
});

test("delete and alter check, inside the transaction, before they write", () => {
  const del = code(read("../app/api/delete-invoice/route.js"));
  const check = del.indexOf("settledAgainst(");
  assert.ok(check > 0 && check < del.indexOf("Invoice.findOneAndDelete("), "delete checks after it deletes");
  assert.match(del, /settledBillProblem\(\{ before: existing, after: null/);

  const alter = code(read("../app/api/sale-alter/route.js"));
  const at = alter.indexOf("settledAgainst(");
  assert.ok(at > 0 && at < alter.indexOf("Invoice.findOneAndUpdate("), "alter checks after it writes");
  assert.match(alter.slice(at, at + 200), /session/);
  assert.match(alter, /balanceDue: invoiceData\.balanceDue/);
});

test("the voucher model is unchanged: allocations stay on the voucher line", () => {
  const model = read("../models/voucherModel.js");
  assert.match(model, /allocations:\[/);
  // And the dead invoice field is still dead -- nothing writes or reads it.
  for (const file of ["../lib/billAdjust.mjs", "../lib/openBillsFor.mjs", "../app/api/voucher-add/route.js"]) {
    assert.doesNotMatch(code(read(file)), /againstInvoiceNo/);
  }
});

console.log(
  process.exitCode ? "\nSome checks failed.\n" : `\n${passed} checks passed.\n`
);
