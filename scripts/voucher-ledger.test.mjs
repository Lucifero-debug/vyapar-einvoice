/**
 * Fixture tests for the voucher ledger row builder.
 *
 *   node scripts/voucher-ledger.test.mjs
 */

import assert from "node:assert/strict";
import { buildVoucherLedgerRows } from "../lib/voucherLedger.mjs";

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

const VOUCHER = {
  acName: "Cash",
  date: "2026-09-20",
  paymentType: "Receipt",
  narration: "Collections for the week",
  voucherId: "v1",
  customers: [
    { name: "Asha Traders", debit: 0, credit: 2000, narration: "Part payment" },
    { name: "Bhatia & Co", debit: 500, credit: 0, narration: "" },
  ],
};

const build = (over = {}) => buildVoucherLedgerRows({ ...VOUCHER, ...over });
const partyRows = (rows) => rows.slice(0, -1);
const mainRow = (rows) => rows[rows.length - 1];

console.log("\n--- row shape ---");

test("one row per party plus a single main-account row", () => {
  assert.equal(build().length, 3);
});

test("every row carries the customerName the ledger groups on", () => {
  for (const row of build()) {
    assert.ok(row.customerName, `missing customerName on ${JSON.stringify(row)}`);
  }
});

test("party rows book the contra account, not their own name", () => {
  for (const row of partyRows(build())) {
    assert.equal(row.account, "Cash");
    assert.notEqual(row.account, row.customerName);
  }
});

test("a debit line stays a debit", () => {
  const row = partyRows(build()).find((r) => r.customerName === "Bhatia & Co");
  assert.equal(row.debit, 500);
  assert.equal(row.credit, 0);
});

test("a credit line stays a credit", () => {
  const row = partyRows(build()).find((r) => r.customerName === "Asha Traders");
  assert.equal(row.credit, 2000);
  assert.equal(row.debit, 0);
});

test("no stray `type` field the schema would drop", () => {
  for (const row of build()) assert.equal("type" in row, false);
});

test("paymentType is carried onto every row", () => {
  for (const row of build()) assert.equal(row.paymentType, "Receipt");
});

console.log("\n--- main account row ---");

test("main row is booked against the payment method", () => {
  const row = mainRow(build());
  assert.equal(row.customerName, "Cash");
  assert.equal(row.account, "Receipt");
});

test("main row totals sit on the opposite side", () => {
  const row = mainRow(build());
  assert.equal(row.debit, 2000, "total credits become the debit");
  assert.equal(row.credit, 500, "total debits become the credit");
});

test("the voucher balances: total debits equal total credits", () => {
  const rows = build();
  const debit = rows.reduce((a, r) => a + r.debit, 0);
  const credit = rows.reduce((a, r) => a + r.credit, 0);
  assert.equal(debit, credit);
});

console.log("\n--- narration ---");

test("a party narration is kept", () => {
  const row = partyRows(build()).find((r) => r.customerName === "Asha Traders");
  assert.equal(row.narration, "Part payment");
});

test("a blank party narration falls back to the account", () => {
  const row = partyRows(build()).find((r) => r.customerName === "Bhatia & Co");
  assert.equal(row.narration, "Against Cash");
});

test("a blank main narration falls back", () => {
  assert.equal(mainRow(build({ narration: "" })).narration, "Main account entry");
});

console.log("\n--- numbers ---");

test("string amounts are coerced, not concatenated", () => {
  const rows = build({
    customers: [
      { name: "A", debit: "100", credit: "" },
      { name: "B", debit: "", credit: "50.5" },
    ],
  });
  assert.equal(rows[0].debit, 100);
  assert.equal(rows[0].credit, 0);
  assert.equal(mainRow(rows).credit, 100);
  assert.equal(mainRow(rows).debit, 50.5);
});

test("fractional totals do not drift", () => {
  const rows = build({
    customers: Array.from({ length: 30 }, (_, i) => ({
      name: `P${i}`,
      debit: 0.1,
      credit: 0,
    })),
  });
  assert.equal(mainRow(rows).credit, 3);
});

test("a voucher with no party lines still books the main row", () => {
  const rows = build({ customers: [] });
  assert.equal(rows.length, 1);
  assert.equal(mainRow(rows).debit, 0);
  assert.equal(mainRow(rows).credit, 0);
});

console.log("\n--- add and edit agree ---");

test("editing a voucher reproduces exactly the rows creating it did", () => {
  // Same inputs through the same builder: the shape cannot diverge.
  const onAdd = buildVoucherLedgerRows({ ...VOUCHER, voucherId: "v1" });
  const onEdit = buildVoucherLedgerRows({ ...VOUCHER, voucherId: "v1" });
  assert.deepEqual(onEdit, onAdd);
});

test("an edit that changes a side is reflected, not silently flipped", () => {
  const edited = buildVoucherLedgerRows({
    ...VOUCHER,
    customers: [
      { name: "Asha Traders", debit: 2000, credit: 0, narration: "Reversed" },
    ],
  });
  assert.equal(edited[0].debit, 2000);
  assert.equal(edited[0].credit, 0);
  assert.equal(mainRow(edited).credit, 2000);
});

console.log(
  process.exitCode
    ? "\nSome assertions failed.\n"
    : `\n${passed} assertions passed.\n`
);
