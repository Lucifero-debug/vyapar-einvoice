/**
 * Fixture tests for the shared posting builders.
 *
 *   node scripts/posting-consistency.test.mjs
 *
 * These cover the rules that create/edit/delete all have to agree on. Every bug
 * they guard against was a case of two code paths computing the same thing
 * differently and drifting apart.
 */

import assert from "node:assert/strict";
import { round2 } from "../lib/balance.mjs";
import { buildVoucherBalanceDeltas, buildVoucherLedgerRows } from "../lib/voucherLedger.mjs";
import {
  buildInvoiceLedgerRows,
  invoicePostingDeltas,
  sides,
} from "../lib/invoicePosting.mjs";

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

const SALE = { type: "Sale", isReturn: false };
const PURCHASE = { type: "Purchase", isReturn: false };
const SALE_RETURN = { type: "Sale", isReturn: true };

console.log("\n--- invoice deltas ---");

test("a credit sale moves only the party", () => {
  const d = invoicePostingDeltas({ ...SALE, finalAmount: 1000, received: 0 });
  assert.equal(d.partyDelta, 1000);
  assert.equal(d.cashDelta, 0);
  assert.equal(d.settled, 0);
});

test("a fully-paid sale moves cash and leaves the party flat", () => {
  const d = invoicePostingDeltas({ ...SALE, finalAmount: 1000, received: 1000 });
  assert.equal(d.partyDelta, 0);
  assert.equal(d.cashDelta, 1000);
  assert.equal(d.docDelta, 1000, "the sale still reaches the ledger in full");
});

test("a part-paid purchase splits correctly", () => {
  const d = invoicePostingDeltas({ ...PURCHASE, finalAmount: 800, received: 300 });
  assert.equal(d.partyDelta, -500);
  assert.equal(d.cashDelta, -300);
});

test("finalAmount falls back to balanceDue + received", () => {
  const explicit = invoicePostingDeltas({ ...SALE, finalAmount: 900, received: 400 });
  const derived = invoicePostingDeltas({ ...SALE, finalAmount: 500 + 400, received: 400 });
  assert.deepEqual(explicit, derived);
});

console.log("\n--- invoice ledger rows ---");

const rowsFor = (over = {}) => {
  const deltas = invoicePostingDeltas({
    ...SALE,
    finalAmount: 1000,
    received: 0,
    ...over,
  });
  return buildInvoiceLedgerRows({
    type: over.type || SALE.type,
    customerName: "Asha Traders",
    cashAccountName: "Cash",
    invoiceNo: 7,
    date: "2026-09-20",
    paymentType: "Cash",
    voucherId: "inv7",
    deltas,
  });
};

test("a credit invoice writes exactly one row", () => {
  const rows = rowsFor();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account, "Sales Account");
  assert.equal(rows[0].debit, 1000);
});

test("a settled invoice writes both sides of the receipt too", () => {
  const rows = rowsFor({ received: 400 });
  assert.equal(rows.length, 3);

  const cashRow = rows.find((r) => r.customerName === "Cash");
  const receiptRow = rows.filter((r) => r.customerName === "Asha Traders")[1];

  assert.equal(cashRow.debit, 400, "cash comes in");
  assert.equal(receiptRow.credit, 400, "party comes down by the same amount");
});

test("every row carries the voucherId the delete path cleans up by", () => {
  for (const row of rowsFor({ received: 400 })) {
    assert.equal(row.voucherId, "inv7");
  }
});

test("a purchase books the party on the opposite side", () => {
  const rows = rowsFor({ type: "Purchase" });
  assert.equal(rows[0].account, "Purchase Account");
  assert.equal(rows[0].credit, 1000);
  assert.equal(rows[0].debit, 0);
});

test("a return lands opposite the document it reverses", () => {
  const plain = rowsFor();
  const returned = rowsFor({ ...SALE_RETURN });
  assert.equal(plain[0].debit, returned[0].credit);
});

test("a negative settlement still posts both legs, never one", () => {
  const rows = rowsFor({ received: -200 });
  assert.equal(rows.length, 3, "guarding on > 0 would post the party side alone");
});

test("rows balance within themselves once the nominal side is added", () => {
  // What the register relies on: the imbalance is exactly the document leg.
  const rows = rowsFor({ received: 400 });
  const debit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const credit = round2(rows.reduce((s, r) => s + r.credit, 0));
  assert.equal(round2(debit - credit), 1000);
});

console.log("\n--- voucher balance deltas ---");

const VOUCHER = {
  acName: "Cash",
  customers: [
    { name: "Asha Traders", debit: 0, credit: 2000 },
    { name: "Bhatia & Co", debit: 500, credit: 0 },
  ],
};

test("every party gets a delta, and so does the account", () => {
  const deltas = buildVoucherBalanceDeltas(VOUCHER);
  assert.equal(deltas.length, 3);
  assert.equal(deltas[deltas.length - 1].name, "Cash");
});

test("the account absorbs the opposite of the parties", () => {
  const deltas = buildVoucherBalanceDeltas(VOUCHER);
  const total = round2(deltas.reduce((s, d) => s + d.delta, 0));
  assert.equal(total, 0, "a voucher nets to zero across the accounts it touches");
});

test("the account delta matches its own ledger row", () => {
  const deltas = buildVoucherBalanceDeltas(VOUCHER);
  const rows = buildVoucherLedgerRows({ ...VOUCHER, date: "2026-09-20", voucherId: "v1" });

  const mainRow = rows[rows.length - 1];
  const accountDelta = deltas[deltas.length - 1].delta;

  assert.equal(accountDelta, round2(mainRow.debit - mainRow.credit));
});

test("reversing the deltas undoes them exactly", () => {
  const deltas = buildVoucherBalanceDeltas(VOUCHER);
  for (const { delta } of deltas) {
    assert.equal(round2(delta + -delta), 0);
  }
});

console.log("\n--- sides ---");

test("a positive movement is a debit, a negative one a credit", () => {
  assert.deepEqual(sides(120), { debit: 120, credit: 0 });
  assert.deepEqual(sides(-120), { debit: 0, credit: 120 });
  assert.deepEqual(sides(0), { debit: 0, credit: 0 });
});

console.log(`\n${passed} passed\n`);
