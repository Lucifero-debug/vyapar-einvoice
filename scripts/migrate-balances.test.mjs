/**
 * Fixture tests for the balance rebuild.
 *
 * Exercises the real `computeRebuild` from the migration script against
 * hand-built documents, so the aggregation is verified without needing a
 * populated database.
 *
 *   node scripts/migrate-balances.test.mjs
 */

import assert from "node:assert/strict";
import { computeRebuild } from "./migrate-balances.mjs";

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

const customer = (name, extra = {}) => ({
  _id: name,
  name,
  openingBal: 0,
  openingMode: "Dr",
  lastBal: 0,
  lastMode: "Dr",
  ...extra,
});

const invoice = (name, type, balanceDue, extra = {}) => ({
  customer: { name },
  type,
  balanceDue,
  return: false,
  ...extra,
});

const rowFor = (result, name) => result.rows.find((r) => r.name === name);

console.log("\n--- the originally reported scenario ---");

test("Cr 5,000 advance then a 3,000 sale rebuilds to Cr 2,000", () => {
  const result = computeRebuild({
    allCustomers: [
      // Corrupted state the old code would have left behind: Dr 8,000.
      customer("Asha Traders", { lastBal: 8000, lastMode: "Dr" }),
    ],
    allInvoices: [invoice("Asha Traders", "Sale", 3000)],
    allVouchers: [
      { acName: "Cash", customers: [{ name: "Asha Traders", credit: 5000 }] },
    ],
  });
  const row = rowFor(result, "Asha Traders");
  assert.equal(row.newBal, -2000);
  assert.equal(row.newMode, "Cr");
});

console.log("\n--- invoice types ---");

test("sale increases the receivable", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [invoice("A", "Sale", 1000)],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 1000);
});

test("purchase makes the party a creditor", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [invoice("A", "Purchase", 1000)],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, -1000);
  assert.equal(rowFor(r, "A").newMode, "Cr");
});

test("a return cancels the invoice it reverses", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [
      invoice("A", "Sale", 1000),
      invoice("A", "Sale", 1000, { return: true }),
    ],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 0);
});

test("purchase return cancels the purchase", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [
      invoice("A", "Purchase", 750),
      invoice("A", "Purchase", 750, { return: true }),
    ],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 0);
});

console.log("\n--- opening balances ---");

test("Cr opening balance is read as negative", () => {
  const r = computeRebuild({
    allCustomers: [customer("A", { openingBal: 4000, openingMode: "Cr" })],
    allInvoices: [],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").opening, -4000);
  assert.equal(rowFor(r, "A").newBal, -4000);
});

test("a magnitude stored with Cr is not double-negated", () => {
  const r = computeRebuild({
    allCustomers: [customer("A", { openingBal: -4000, openingMode: "Cr" })],
    allInvoices: [],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").opening, -4000);
});

test("with no mode ever chosen, the raw sign is preserved", () => {
  const r = computeRebuild({
    allCustomers: [customer("A", { openingBal: -1500, openingMode: "" })],
    allInvoices: [],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").opening, -1500);
});

console.log("\n--- vouchers ---");

test("a receipt reduces what the party owes", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [invoice("A", "Sale", 5000)],
    allVouchers: [{ acName: "Cash", customers: [{ name: "A", credit: 2000 }] }],
  });
  assert.equal(rowFor(r, "A").newBal, 3000);
});

test("acName is not treated as a party unless it is a voucher line", () => {
  const r = computeRebuild({
    allCustomers: [customer("A"), customer("Cash")],
    allInvoices: [],
    allVouchers: [{ acName: "Cash", customers: [{ name: "A", credit: 2000 }] }],
  });
  assert.equal(rowFor(r, "Cash").newBal, 0, "Cash must be untouched");
  assert.equal(rowFor(r, "A").newBal, -2000);
});

console.log("\n--- edge cases ---");

test("bulk-upload invoices are excluded", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [invoice("A", "Sale", 999, { source: "upload" })],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 0);
  assert.equal(r.skippedUploads, 1);
});

test("documents for an unknown party are reported as orphans", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [invoice("Ghost Ltd", "Sale", 100)],
    allVouchers: [],
  });
  assert.deepEqual(r.orphans, ["Ghost Ltd"]);
});

test("a customer with no documents keeps only its opening balance", () => {
  const r = computeRebuild({
    allCustomers: [customer("A", { openingBal: 250, lastBal: 99999 })],
    allInvoices: [],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 250);
  assert.equal(rowFor(r, "A").txns, 0);
});

test("repeated fractional amounts do not accumulate float drift", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: Array.from({ length: 300 }, () => invoice("A", "Sale", 0.1)),
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 30);
});

test("an invoice with no customer name is ignored, not crashed on", () => {
  const r = computeRebuild({
    allCustomers: [customer("A")],
    allInvoices: [{ type: "Sale", balanceDue: 500 }],
    allVouchers: [],
  });
  assert.equal(rowFor(r, "A").newBal, 0);
});

test("the rebuild is idempotent", () => {
  const args = {
    allCustomers: [customer("A", { lastBal: 12345, lastMode: "Cr" })],
    allInvoices: [invoice("A", "Sale", 400)],
    allVouchers: [{ acName: "Cash", customers: [{ name: "A", debit: 100 }] }],
  };
  const first = rowFor(computeRebuild(args), "A");
  const second = rowFor(
    computeRebuild({
      ...args,
      allCustomers: [
        customer("A", { lastBal: first.newBal, lastMode: first.newMode }),
      ],
    }),
    "A"
  );
  assert.equal(second.newBal, first.newBal);
  assert.equal(second.newMode, first.newMode);
});

console.log(
  process.exitCode ? "\nSome assertions failed.\n" : `\n${passed} assertions passed.\n`
);
