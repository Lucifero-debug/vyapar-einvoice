/**
 * Fixture tests for sales and purchase challans.
 *
 *   node scripts/challan.test.mjs
 *
 * A challan is the paper that goes with the goods when the tax invoice is not
 * being raised at dispatch. Four things matter more than the feature:
 *
 *   1. IT POSTS NOTHING. No party balance, no GST, no ledger leg, no stock
 *      movement. Nothing is owed until it is billed, and the stock ledger
 *      stays fed by invoices and stock vouchers exactly as it is today.
 *   2. IT NEVER TAKES AN INVOICE NUMBER. GST invoice numbering has to be
 *      consecutive; a challan that burnt 411 would leave a hole somebody has
 *      to explain to an officer.
 *   3. THE ARITHMETIC IS lib/orderStatus.mjs's, not a second copy. A challan
 *      line has the same three quantities an order line has, and the pending
 *      subtraction must be one implementation.
 *   4. THE CHALLAN LINK IS INDEPENDENT OF THE ORDER LINK. Goods ordered in
 *      March, delivered on a challan in April and billed in May are ONE
 *      invoice line carrying both references -- which is why Sigfa's Salpur1
 *      has both sets of columns side by side.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CHALLAN_KINDS,
  CHALLAN_STATUSES,
  CHALLAN_TYPES,
  PENDING_COLUMNS,
  PENDING_SCOPES,
  PENDING_SCOPE_LABELS,
  QTY_EPSILON,
  STATUS_LABELS,
  cancelledQty,
  challanDeleteBlockedReason,
  challanEditBlockedReason,
  challanKey,
  challanKind,
  challanLabel,
  challanProblem,
  challanRef,
  challanRefsLabel,
  challanRefsText,
  challanStatus,
  challanSubtext,
  challanTitle,
  challanTotal,
  challanedQty,
  claimsFromItems,
  counterFor,
  invoicedQty,
  isChallanType,
  isOpenChallan,
  isPendingScope,
  lineStatus,
  mixedSelectionReason,
  netClaims,
  overBilledReason,
  pendingBook,
  pendingBookTotals,
  pendingChallanValue,
  pendingLines,
  pendingQty,
  printableChallanRefs,
  scopeType,
  toInvoiceLines,
} from "../lib/challan.mjs";
import * as orderStatus from "../lib/orderStatus.mjs";

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

const CHALLAN = {
  challanNo: 17,
  type: "Sale",
  date: "2026-10-01",
  customer: { name: "Acme Traders" },
  items: [
    { _id: "l1", name: "MS Plate 10mm", hsn: "7208", quantity: 250, cost: 60, discount: 0, invoicedQty: 100, cancelledQty: 0 },
    { _id: "l2", name: "Washer 12mm", quantity: 500, cost: 2, discount: 0, invoicedQty: 0, cancelledQty: 0 },
  ],
};

const FRESH = {
  challanNo: 18,
  type: "Purchase",
  date: "2026-10-05",
  customer: { name: "Bharat Steel" },
  items: [{ _id: "p1", name: "MS Plate 10mm", quantity: 80, cost: 55, invoicedQty: 0, cancelledQty: 0 }],
};

console.log("\n--- Sigfa's two kinds ---");

test("SC and PC, with the titles Sigfa prints", () => {
  // From the two rows its MkeyMaster is seeded with.
  assert.deepEqual(CHALLAN_TYPES, ["Sale", "Purchase"]);
  assert.equal(CHALLAN_KINDS.Sale.mkey, "SC");
  assert.equal(CHALLAN_KINDS.Purchase.mkey, "PC");
  assert.equal(challanLabel("Sale"), "Sales Challan");
  assert.equal(challanLabel("Purchase"), "Purchase Challan");
  assert.equal(challanTitle("Sale"), "SALES CHALLAN");
  assert.equal(challanTitle("Purchase"), "PURCHASE CHALLAN");
  // Its second name for the same document, the way a production voucher has
  // both "Goods Issued" and "Issue Slip".
  assert.equal(CHALLAN_KINDS.Sale.slip, "M.R.O");
  assert.equal(CHALLAN_KINDS.Purchase.slip, "M.R.I");
  // Its own keyboard shortcuts.
  assert.equal(CHALLAN_KINDS.Sale.shortcut, "Ctrl+B");
  assert.equal(CHALLAN_KINDS.Purchase.shortcut, "Ctrl+E");
  assert.equal(isChallanType("Sale"), true);
  assert.equal(isChallanType("Transfer"), false, "TC is a branch movement and this app has no branches");
  assert.equal(challanKind("nope"), null);
  assert.equal(challanLabel("nope"), "");
});

test("IT NEVER TAKES AN INVOICE NUMBER", () => {
  // GST invoice numbering has to be consecutive. Sigfa keeps the series apart
  // too -- VOUCHER Text(16) per Mkey, with "Ask Series In Purchase Challan".
  assert.equal(counterFor("Sale"), "challanNo:Sale");
  assert.equal(counterFor("Purchase"), "challanNo:Purchase");
  assert.equal(counterFor("nope"), "");
  // Two series, and neither is the invoice's.
  assert.notEqual(counterFor("Sale"), counterFor("Purchase"));
  const counter = read("../lib/getNextChallanNo.js");
  assert.match(counter, /Challan\.findOne\(\{ type \}, \{ challanNo: 1 \}/);
  assert.equal(/invoiceNo/.test(code(counter)), false, "it must not read the invoice series");
  // And it nudges past the highest challan that exists, or a fresh counter
  // starts at 1 and collides with the book.
  assert.match(counter, /\$max: \{ value: Number\(highest\.challanNo\) \}/);
});

console.log("\n--- it posts nothing ---");

test("NO GST, NO TOTALS TO RECONCILE, ON THE DOCUMENT ITSELF", () => {
  // The liability arises on the invoice. Sigfa's challan rows carry tax
  // columns only because SALPUR is one table for six document types, and its
  // GST returns read Mkey in ('SI','PI',...) and never SC or PC.
  const model = code(read("../models/challanModel.js"));
  for (const field of ["gst:", "taxType", "finalAmount", "partyTaxes", "received", "balanceDue", "paymentType"]) {
    assert.equal(model.includes(field), false, `the challan must not carry ${field}`);
  }
  // It does carry a plain total, for the register to sort on.
  assert.match(model, /totalAmount/);
});

test("NO PARTY BALANCE, NO LEDGER LEG, NO STOCK MOVEMENT", () => {
  const rules = code(read("../lib/challan.mjs"));
  const claims = code(read("../lib/challanClaims.mjs"));
  for (const src of [rules, claims]) {
    assert.equal(/lastBal/.test(src), false);
    assert.equal(/ItemLedger/.test(src), false);
    assert.equal(/ledgerModel|Ledger\b/.test(src), false);
    assert.equal(/receiptQuantity|issueQuantity/.test(src), false);
  }
  // The rules module is pure: only the challan collection is touched, and
  // only by the claims module.
  assert.equal(/import mongoose/.test(read("../lib/challan.mjs")), false);
  assert.equal(/from "\.\.\/models/.test(read("../lib/challan.mjs")), false);
  assert.match(claims, /import Challan from "\.\.\/models\/challanModel"/);
});

test("the invoice is still what moves the stock", () => {
  // The user's decision, and Sigfa's default: its "Stock Effect With Challan"
  // switch is what makes a challan feed the stock ledger, and with it off the
  // stock moves when the invoice is raised. Nothing in the posting path
  // changed, so this asserts the writer is untouched by the challan work.
  const writer = code(read("../lib/itemLedger.mjs"));
  assert.equal(/challan/i.test(writer), false, "the stock writer must know nothing about challans");
  const save = read("../app/api/save-invoice/route.js");
  assert.match(save, /writeItemLedgerRows/, "and the invoice still writes its own stock rows");
});

console.log("\n--- the arithmetic is the order module's ---");

test("THE SUBTRACTION HAS ONE IMPLEMENTATION, NOT TWO", () => {
  // A challan line has the same three quantities an order line has. Every one
  // of these helpers in lib/orderStatus.mjs reads only line.quantity,
  // line.cancelledQty, line.invoicedQty and doc.items -- not one of them
  // mentions an order -- so they are re-exported rather than rewritten.
  assert.equal(pendingQty, orderStatus.pendingQty);
  assert.equal(cancelledQty, orderStatus.cancelledQty);
  assert.equal(invoicedQty, orderStatus.invoicedQty);
  assert.equal(lineStatus, orderStatus.lineStatus);
  assert.equal(pendingLines, orderStatus.pendingLines);
  assert.equal(QTY_EPSILON, orderStatus.QTY_EPSILON);
  // And the module does not define a second copy of the subtraction.
  const src = code(read("../lib/challan.mjs"));
  assert.equal(/quantity\s*-\s*\w*cancelled/i.test(src), false, "a second pending subtraction");
});

test("the three quantities and the derived status", () => {
  assert.equal(challanedQty(CHALLAN.items[0]), 250);
  assert.equal(invoicedQty(CHALLAN.items[0]), 100);
  assert.equal(pendingQty(CHALLAN.items[0]), 150);
  assert.equal(challanStatus(CHALLAN), "partial");
  assert.equal(isOpenChallan(CHALLAN), true);
  assert.equal(challanStatus(FRESH), "open");
  assert.equal(challanStatus({ items: [{ quantity: 5, invoicedQty: 5 }] }), "closed");
  assert.equal(isOpenChallan({ items: [{ quantity: 5, invoicedQty: 5 }] }), false);
  assert.equal(challanStatus({ items: [] }), "open", "a challan with no lines is a draft");
  assert.deepEqual(CHALLAN_STATUSES, ["open", "partial", "closed", "cancelled"]);
  assert.equal(STATUS_LABELS.open, "Pending");
});

test("its value, and the value still to bill", () => {
  assert.equal(challanTotal(CHALLAN.items), 16000, "250x60 + 500x2");
  assert.equal(pendingChallanValue(CHALLAN), 10000, "150x60 + 500x2");
});

test("already billed anchors the document in place", () => {
  assert.match(challanDeleteBlockedReason(CHALLAN), /already been billed/);
  assert.match(challanDeleteBlockedReason(CHALLAN), /challan/, "and says challan, not order");
  assert.equal(challanDeleteBlockedReason(FRESH), null);
  // An edit that drops below what is billed is refused, in the challan's own
  // words rather than the order module's.
  const cut = challanEditBlockedReason(CHALLAN.items, [{ ...CHALLAN.items[0], quantity: 50 }, CHALLAN.items[1]]);
  assert.match(cut, /the challan cannot drop to 50/);
  assert.equal(/\border\b/.test(cut), false, "a message saying 'order' on a challan screen is a bug report");
  // And the allowance it quotes is never negative.
  assert.equal(/-\d/.test(cut), false, `"only -50 may be cancelled" is not a sentence: ${cut}`);
  assert.equal(challanEditBlockedReason(CHALLAN.items, CHALLAN.items), null);
});

console.log("\n--- the link from an invoice line ---");

test("all three parts, or it is a plain line", () => {
  // A reference naming a challan but not WHICH line of it cannot be settled,
  // and claiming against the first matching item name instead is how two
  // lines of the same item end up both billed and both still pending.
  assert.deepEqual(challanRef({ challanNo: 17, challanType: "Sale", challanLineId: "l1" }), {
    challanNo: 17, challanType: "Sale", lineId: "l1",
  });
  assert.equal(challanRef({ challanNo: 17, challanType: "Sale" }), null);
  assert.equal(challanRef({ challanType: "Sale", challanLineId: "l1" }), null);
  assert.equal(challanRef({ challanNo: 17, challanType: "Nonsense", challanLineId: "l1" }), null);
  assert.equal(challanRef({ challanNo: 0, challanType: "Sale", challanLineId: "l1" }), null);
  assert.equal(challanRef({}), null);
  assert.equal(challanRef(null), null);
  assert.equal(challanKey("Sale", 17), "Sale#17");
  assert.notEqual(challanKey("Sale", 1), challanKey("Purchase", 1));
});

test("ONE LINE CAN CARRY A CHALLAN REF AND AN ORDER REF AT ONCE", () => {
  // Goods ordered in March, delivered on a challan in April, billed in May.
  // Sigfa's Salpur1 has CBRCODE/COPNG/CHALLAN/CHRefNo AND
  // OBRCODE/OMKEY/ORDERNO/OREFNO side by side for exactly this.
  const line = {
    name: "MS Plate 10mm", quantity: 150,
    orderNo: 7, orderType: "Sale", orderLineId: "o9",
    challanNo: 17, challanType: "Sale", challanLineId: "l1",
  };
  assert.deepEqual(challanRef(line), { challanNo: 17, challanType: "Sale", lineId: "l1" });
  assert.deepEqual(orderStatus.lineRef(line), { orderNo: 7, orderType: "Sale", lineId: "o9" });
  // The two claim groupings are independent and both see it.
  assert.equal(claimsFromItems([line]).length, 1);
  assert.equal(orderStatus.claimsFromItems([line]).length, 1);
  // And the model declares both sets, because strict mode drops what it does
  // not -- a dropped reference leaves the document pending for good.
  const model = read("../models/invoiceModel.js");
  for (const field of ["challanNo", "challanType", "challanLineId", "challanDate"]) {
    assert.match(model, new RegExp(`${field}\\s*:\\s*\\{`), field);
  }
});

test("a claim accumulates when one line splits across two invoice lines", () => {
  // Part of a delivery billed at the agreed rate and part at a revised one is
  // ordinary. Taking the last value instead would under-claim and leave the
  // challan pending forever.
  const groups = claimsFromItems([
    { challanNo: 17, challanType: "Sale", challanLineId: "l1", quantity: 60 },
    { challanNo: 17, challanType: "Sale", challanLineId: "l1", quantity: 90 },
    { challanNo: 17, challanType: "Sale", challanLineId: "l2", quantity: 500 },
    { name: "Loose line with no challan", quantity: 5 },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].byLine.get("l1"), 150);
  assert.equal(groups[0].byLine.get("l2"), 500);
  // A zero or negative quantity claims nothing.
  assert.equal(claimsFromItems([{ challanNo: 1, challanType: "Sale", challanLineId: "x", quantity: 0 }]).length, 0);
});

test("an edit moves each challan by the DIFFERENCE only", () => {
  const before = [{ challanNo: 17, challanType: "Sale", challanLineId: "l1", quantity: 150 }];
  const after = [{ challanNo: 17, challanType: "Sale", challanLineId: "l1", quantity: 100 }];
  const [group] = netClaims(before, after);
  assert.equal(group.byLine.get("l1"), -50, "fifty handed back");
  // An edit that touched no challan produces no work at all.
  assert.deepEqual(netClaims(before, before), []);
  assert.deepEqual(netClaims([], []), []);
  // A line that only appears after is a fresh claim.
  assert.equal(netClaims([], after)[0].byLine.get("l1"), 100);
  // And one that only appears before is released.
  assert.equal(netClaims(before, [])[0].byLine.get("l1"), -150);
});

console.log("\n--- challan to invoice, Sigfa's Alt+H ---");

test("only the pending quantity is offered, carrying the reference", () => {
  const lines = toInvoiceLines(CHALLAN);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].quantity, 150, "not the 250 that went out");
  assert.equal(lines[0].cost, 60);
  assert.equal(lines[0].challanNo, 17);
  assert.equal(lines[0].challanType, "Sale");
  assert.equal(lines[0].challanLineId, "l1");
  assert.equal(lines[0].challanDate, "2026-10-01");
  // `cost`, not `rate`, so the line can be handed to the billing form
  // untranslated -- the same reason the order module uses it.
  assert.equal("rate" in lines[0], false);
  // A fully billed challan offers nothing.
  assert.deepEqual(toInvoiceLines({ challanNo: 1, type: "Sale", items: [{ _id: "a", quantity: 5, invoicedQty: 5 }] }), []);
});

test("Sigfa's own over-billing refusal, in its own words", () => {
  // "Received Qty. Is More Than Challan Qty. !"
  assert.match(overBilledReason(CHALLAN.items[0], 200), /more than challan qty/i);
  assert.match(overBilledReason(CHALLAN.items[0], 200), /200 against 150/);
  assert.equal(overBilledReason(CHALLAN.items[0], 150), null, "exactly the pending quantity is fine");
  assert.equal(overBilledReason(CHALLAN.items[0], 149), null);
  // The authoritative refusal is applyDeltas inside the transaction; this is
  // the same rule stated early so the screen can say it before saving.
  assert.equal(
    challanEditBlockedReason === orderStatus.editBlockedReason,
    false,
    "the challan wording is its own"
  );
});

test("one invoice, one party, one treatment", () => {
  // Sigfa: "Please Select Challans With Same Effect Value !"
  assert.equal(mixedSelectionReason([CHALLAN]), null);
  assert.match(mixedSelectionReason([CHALLAN, FRESH]), /sales challan and a purchase challan/);
  assert.match(
    mixedSelectionReason([CHALLAN, { ...CHALLAN, challanNo: 19, customer: { name: "Other" } }]),
    /different parties/
  );
  assert.match(mixedSelectionReason([]), /at least one/);
  assert.match(mixedSelectionReason(null), /at least one/);
  // Every one already billed is nothing to bill.
  assert.match(
    mixedSelectionReason([{ type: "Sale", customer: { name: "A" }, items: [{ quantity: 5, invoicedQty: 5 }] }]),
    /already been billed/
  );
  // Two challans for the SAME party bill together, which is the whole point.
  assert.equal(mixedSelectionReason([CHALLAN, { ...CHALLAN, challanNo: 19 }]), null);
});

console.log("\n--- what the printed bill says ---");

test("every challan a bill draws on, from its lines", () => {
  const refs = printableChallanRefs({ items: toInvoiceLines(CHALLAN) });
  assert.deepEqual(refs, [{ challanNo: 17, challanType: "Sale", date: "2026-10-01" }]);
  assert.equal(challanRefsLabel(refs), "Challan No");
  assert.equal(challanRefsLabel([...refs, { challanNo: 19 }]), "Challan Nos");
  assert.equal(challanRefsText(refs, (d) => String(d).slice(0, 10)), "17 (2026-10-01)");
  // A ref with no date prints as the bare number: better a number with no
  // date than a date that was invented.
  assert.equal(challanRefsText([{ challanNo: 17 }], () => ""), "17");
  // Sorted and deduplicated across lines.
  const two = printableChallanRefs({
    items: [
      { challanNo: 19, challanType: "Sale", challanLineId: "a", quantity: 1, challanDate: "2026-10-09" },
      { challanNo: 17, challanType: "Sale", challanLineId: "b", quantity: 1, challanDate: "2026-10-01" },
      { challanNo: 17, challanType: "Sale", challanLineId: "c", quantity: 1, challanDate: "2026-10-01" },
    ],
  });
  assert.deepEqual(two.map((r) => r.challanNo), [17, 19]);
});

test("the OTHER party's typed challan number is not blanked", () => {
  // Sigfa's SALPUR.CHALLAN + CHDATE is a memo typed into the dispatch block,
  // like GRNO. Without this fallback, adding the feature would have blanked
  // the "Challan No" line on every historical bill that had one typed in.
  assert.deepEqual(printableChallanRefs({ items: [], challanNo: "DC/114", challanDate: "2026-09-01" }), [
    { challanNo: "DC/114", challanType: "", date: "2026-09-01" },
  ]);
  // A line reference WINS over the typed one: it is the document in our book.
  const both = printableChallanRefs({ items: toInvoiceLines(CHALLAN), challanNo: "DC/114" });
  assert.equal(both.length, 1);
  assert.equal(both[0].challanNo, 17);
  assert.deepEqual(printableChallanRefs({}), []);
  // And the header pair is declared on the invoice, as a String.
  const model = read("../models/invoiceModel.js");
  assert.match(model, /challanNo: \{ type: String \}/);
  assert.match(model, /challanDate: \{ type: Date \}/);
});

console.log("\n--- the Pending Challan Book ---");

test("Sigfa's two scopes, and it reports per LINE", () => {
  // Its own scope line reads "SALES PENDING CHALLAN : PURCHASE PENDING
  // CHALLAN : DEBIT NOTE PENDING SALES CHALLAN"; the third is its excise-era
  // job-work case, kept here as a column instead.
  assert.deepEqual(PENDING_SCOPES, ["sale", "purchase"]);
  assert.equal(isPendingScope("sale"), true);
  assert.equal(isPendingScope("debit"), false);
  assert.equal(scopeType("purchase"), "Purchase");
  assert.equal(scopeType("sale"), "Sale");
  assert.equal(scopeType("nonsense"), "Sale");
  assert.ok(PENDING_SCOPE_LABELS.purchase);

  const rows = pendingBook({ challans: [CHALLAN, FRESH], scope: "sale" });
  // Per line, because a challan half billed has some lines that matter and
  // some that do not.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.item), ["MS Plate 10mm", "Washer 12mm"]);
  assert.equal(rows[0].challaned, 250);
  assert.equal(rows[0].invoiced, 100);
  assert.equal(rows[0].pending, 150);
  assert.equal(rows[0].value, 9000, "the PENDING quantity at the line's rate");
  assert.equal(rows[0].party, "Acme Traders");
  assert.equal(rows[0].jobWork, false);
  // The other scope sees only the other type.
  const purchase = pendingBook({ challans: [CHALLAN, FRESH], scope: "purchase" });
  assert.deepEqual(purchase.map((r) => r.challanNo), [18]);
  // A fully billed line is not pending and is not on the book at all.
  assert.deepEqual(
    pendingBook({ challans: [{ type: "Sale", challanNo: 1, items: [{ quantity: 5, invoicedQty: 5 }] }] }),
    []
  );
});

test("oldest first, because the oldest is the one being chased", () => {
  const rows = pendingBook({
    challans: [
      { challanNo: 30, type: "Sale", date: "2026-10-09", customer: { name: "B" }, items: [{ _id: "x", name: "A", quantity: 1, cost: 1 }] },
      { challanNo: 12, type: "Sale", date: "2026-08-01", customer: { name: "A" }, items: [{ _id: "y", name: "B", quantity: 1, cost: 1 }] },
    ],
  });
  assert.deepEqual(rows.map((r) => r.challanNo), [12, 30]);
});

test("the totals count challans and parties, not just rows", () => {
  const rows = pendingBook({ challans: [CHALLAN], scope: "sale" });
  const t = pendingBookTotals(rows);
  assert.equal(t.lines, 2);
  assert.equal(t.challans, 1, "two lines of one challan is one challan");
  assert.equal(t.parties, 1);
  assert.equal(t.challaned, 750);
  assert.equal(t.invoiced, 100);
  assert.equal(t.pending, 650);
  assert.equal(t.value, 10000);
});

test("the book's columns use Sigfa's captions", () => {
  const labels = PENDING_COLUMNS.map((c) => c.label);
  assert.ok(labels.includes("Challan No."));
  assert.ok(labels.includes("Challan Date"));
  assert.ok(labels.includes("Challan Qty."));
  assert.ok(labels.includes("Party Name"));
  assert.ok(labels.includes("Item Name"));
  // Every column reads a key the rows actually carry.
  const row = pendingBook({ challans: [CHALLAN] })[0];
  for (const c of PENDING_COLUMNS) assert.ok(c.key in row, c.key);
  // And no column is a dead null.
  for (const key of Object.keys(row)) {
    assert.notEqual(row[key], undefined, key);
  }
});

console.log("\n--- saving one ---");

test("a challan with no items is not a delivery", () => {
  assert.equal(challanProblem(CHALLAN), null);
  assert.match(challanProblem({ ...CHALLAN, items: [] }), /no items is not a delivery/);
  assert.match(challanProblem({ ...CHALLAN, type: "Nonsense" }), /sales or a purchase challan/);
  assert.match(challanProblem({ ...CHALLAN, customer: {} }), /Pick the customer/);
  assert.match(challanProblem({ ...FRESH, customer: {} }), /Pick the supplier/);
  assert.match(challanProblem({ ...CHALLAN, date: null }), /give the challan a date/i);
  assert.match(
    challanProblem({ ...CHALLAN, items: [{ name: "X", quantity: 0 }] }),
    /give the quantity going out/
  );
  assert.match(challanProblem({ ...CHALLAN, items: [{ quantity: 5 }] }), /needs an item/);
});

test("the register row says how much is left, not just 'open'", () => {
  // A row that says "open" and nothing else makes somebody open the document
  // to find out how much is left.
  assert.match(challanSubtext(CHALLAN), /1 of 2 lines billed/);
  assert.match(challanSubtext(CHALLAN), /650 still to bill/);
  assert.match(challanSubtext(FRESH), /1 line, none billed/);
  assert.equal(challanSubtext({ items: [] }), "No items yet");
  assert.match(challanSubtext({ items: [{ quantity: 5, invoicedQty: 5 }] }), /Fully billed/);
  assert.equal(challanSubtext({ items: [{ quantity: 5, cancelledQty: 5 }] }), "Cancelled");
});

console.log("\n--- the three routes that settle it ---");

test("ONLY lib/challanClaims.mjs MOVES A CHALLAN'S QUANTITIES", () => {
  // The over-billing guard only guards what goes through there, so none of
  // the three routes may do the subtraction itself.
  for (const route of [
    "../app/api/save-invoice/route.js",
    "../app/api/delete-invoice/route.js",
    "../app/api/sale-alter/route.js",
  ]) {
    const src = code(read(route));
    assert.equal(/invoicedQty/.test(src), false, `${route} moves a quantity itself`);
    assert.equal(/challanModel/.test(src), false, `${route} writes the challan directly`);
  }
  assert.match(read("../app/api/save-invoice/route.js"), /claimChallanQty\(\{ session, items: invoice\.items \}\)/);
  assert.match(read("../app/api/delete-invoice/route.js"), /releaseChallanQty\(\{ session, items: deletedInvoice\.items \}\)/);
  assert.match(read("../app/api/sale-alter/route.js"), /reconcileChallanQty\(\{/);
});

test("the challan settlement runs BESIDE the order one, not instead of it", () => {
  // One line can carry both references, so both settlements must run.
  for (const [route, order, challan] of [
    ["../app/api/save-invoice/route.js", "claimOrderQty", "claimChallanQty"],
    ["../app/api/delete-invoice/route.js", "releaseOrderQty", "releaseChallanQty"],
    ["../app/api/sale-alter/route.js", "reconcileOrderQty", "reconcileChallanQty"],
  ]) {
    const src = read(route);
    assert.ok(src.includes(order), `${route} lost the order settlement`);
    assert.ok(src.includes(challan), `${route} has no challan settlement`);
  }
});

test("it settles inside the caller's transaction, or not at all", () => {
  // An invoice that committed while its challan's claim rolled back is the
  // worst of both states: the goods are billed and the challan still says
  // they are pending.
  const claims = read("../lib/challanClaims.mjs");
  assert.match(claims, /\.session\(session\)/);
  assert.match(claims, /\{ session \}/);
  assert.match(claims, /AbortTransaction/);
  // And a reference to a challan that is gone is refused rather than skipped.
  assert.match(claims, /no longer exists/);
});

console.log(`\n  ${passed} checks passed\n`);
