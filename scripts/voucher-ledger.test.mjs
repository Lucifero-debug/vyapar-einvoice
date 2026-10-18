/**
 * Fixture tests for the voucher ledger row builder.
 *
 *   node scripts/voucher-ledger.test.mjs
 */

import assert from "node:assert/strict";
import { accountContra, buildVoucherLedgerRows } from "../lib/voucherLedger.mjs";
import { VOUCHER_KINDS } from "../lib/voucherKinds.mjs";

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
  // Single-sided vouchers, which is all the app can produce for a kind whose
  // column is locked: total credits become the account's debit, total debits
  // become its credit. This is what the fixture below used to prove in one
  // case by feeding BOTH sides at once.
  const received = mainRow(build({ customers: [{ name: "A", debit: 0, credit: 2000 }] }));
  assert.equal(received.debit, 2000, "total credits become the debit");
  assert.equal(received.credit, 0, "and nothing on the other side");

  const paid = mainRow(build({ customers: [{ name: "A", debit: 500, credit: 0 }] }));
  assert.equal(paid.credit, 500, "total debits become the credit");
  assert.equal(paid.debit, 0);
});

test("a voucher with lines on both sides nets onto one side", () => {
  /*
    The fixture at the top has lines in BOTH columns -- a voucher saved
    before the kinds existed, which nothing validates on the way in because
    nothing re-posts it. The two notes can be entered this way on purpose
    (lib/voucherKinds.mjs), so this shape is reachable again rather than
    merely historical.

    This asserted Dr 2000 / Cr 500 -- the two totals written as a PAIR --
    and that is what the builder did while every kind with an account was
    locked to one column, where one total was always zero and the pair and
    the net were the same figures. A row carrying a debit AND a credit of
    its own is not an entry anybody can read, and it is not what the account
    absorbed. It absorbed the difference.
  */
  const row = mainRow(build());
  assert.equal(row.debit, 1500, "Cr 2000 less Dr 500, as a debit");
  assert.equal(row.credit, 0, "one side, not both");
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
  // Both lines on the SAME side on purpose. The totals are what this is
  // really about, and two figures on one side is the shape a concatenation
  // bug survives: "100" + "50.5" is "10050.5", which rounds to itself and
  // reaches the ledger looking like a number.
  const rows = build({
    customers: [
      { name: "A", debit: "", credit: "100" },
      { name: "B", debit: "", credit: "50.5" },
    ],
  });
  assert.equal(rows[0].credit, 100, "the line itself was not coerced");
  assert.equal(rows[0].debit, 0);
  assert.equal(mainRow(rows).debit, 150.5, "the totals were joined, not added");
  assert.equal(mainRow(rows).credit, 0);
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

console.log("\n--- credit and debit notes ---");

/* A note books against a head, not a till: acName is set, paymentType is not. */
const NOTE = {
  acName: "Discount Allowed",
  date: "2026-10-18",
  paymentType: "",
  narration: "Rate difference on bill 12",
  voucherId: "cn1",
  customers: [{ name: "A A ENTERPRISES", debit: 0, credit: 500 }],
};

const note = (over = {}) =>
  buildVoucherLedgerRows({ kind: "CREDIT_NOTE", ...NOTE, ...over });

test("a credit note credits the party and debits the head", () => {
  const rows = note();
  assert.equal(rows.length, 2, "a party row and the account row");

  const [party, account] = rows;
  assert.equal(party.customerName, "A A ENTERPRISES");
  assert.equal(party.credit, 500, "the party was not credited");
  assert.equal(party.debit, 0);
  assert.equal(party.account, "Discount Allowed", "the party row names the wrong contra");

  assert.equal(account.customerName, "Discount Allowed");
  assert.equal(account.debit, 500, "the head was not debited");
  assert.equal(account.credit, 0);
});

test("a two-sided note posts the head's net", () => {
  /*
    Why the notes are free-sided at all: an adjustment honestly has both
    sides -- part discount and part rate difference, or a balance moved from
    one party to another. Both notes were locked to a single column when they
    were added and the screen refused figures that were not mistakes
    (lib/voucherKinds.mjs).

    The head takes what is left over, on ONE side. The pair this replaced
    would have written Dr 500 and Cr 300 onto the same row.
  */
  const rows = note({
    customers: [
      { name: "A A ENTERPRISES", debit: 0, credit: 500 },
      { name: "B B TRADERS", debit: 300, credit: 0 },
    ],
  });

  const account = mainRow(rows);
  assert.equal(account.customerName, "Discount Allowed");
  assert.equal(account.debit, 200, "Cr 500 less Dr 300");
  assert.equal(account.credit, 0, "one side, not both");

  // Each party keeps the side it was entered on.
  assert.equal(rows[0].credit, 500);
  assert.equal(rows[1].debit, 300);

  // And it still nets to zero across every row it wrote, which is the only
  // thing the trial balance asks of it.
  const out = rows.reduce((sum, r) => sum + r.debit - r.credit, 0);
  assert.equal(Math.round(out * 100) / 100, 0);
});

test("a debit note is the same entry the other way up", () => {
  const rows = buildVoucherLedgerRows({
    kind: "DEBIT_NOTE",
    ...NOTE,
    acName: "Rejected Material",
    customers: [{ name: "SUPPLIER LTD", debit: 500, credit: 0 }],
  });
  const [party, account] = rows;
  assert.equal(party.debit, 500, "the party was not debited");
  assert.equal(account.credit, 500, "the head was not credited");
});

test("a note posts no cash leg at all", () => {
  // The whole point of splitting needsAccount from needsPaymentType: a
  // note that wrote a cash row would move money that never moved.
  for (const row of note()) {
    assert.notEqual(row.paymentType, "Cash");
    assert.notEqual(row.paymentType, "Bank");
    assert.equal(row.paymentType, "Credit Note", "the row should say what it is");
  }
});

test("a note nets to zero, like every other kind", () => {
  const rows = note();
  const debit = rows.reduce((s, r) => s + r.debit, 0);
  const credit = rows.reduce((s, r) => s + r.credit, 0);
  assert.equal(debit, credit, `out by ${debit - credit}`);
});

test("every row of a note says which kind wrote it", () => {
  for (const row of note()) assert.equal(row.voucherKind, "CREDIT_NOTE");
});

test("the account row names the party it was raised against", () => {
  // A receipt's account row shows the instrument. A note has none, so the
  // useful answer is who it was for.
  assert.equal(note()[1].account, "A A ENTERPRISES");

  // With more than one party there is no single answer, and naming one of
  // them would be the ledger asserting something nobody entered.
  const many = note({
    customers: [
      { name: "A", credit: 100 },
      { name: "B", credit: 100 },
    ],
  });
  assert.equal(many[many.length - 1].account, "Credit Note");
});

test("the three that move money still book against their instrument", () => {
  assert.equal(accountContra(VOUCHER_KINDS.RECEIPT, [{ name: "A" }], "Cash"), "Cash");
  assert.equal(accountContra(VOUCHER_KINDS.CONTRA, [{ name: "A" }], "Bank"), "Bank");
});

console.log(
  process.exitCode
    ? "\nSome assertions failed.\n"
    : `\n${passed} assertions passed.\n`
);
