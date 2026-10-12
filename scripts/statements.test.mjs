/**
 * Fixture tests for customer and supplier statements.
 *
 *   node scripts/statements.test.mjs
 *
 * A statement is the only report in this app that LEAVES the building. It is
 * emailed to a customer who will check it against their own books and ring up
 * about any difference, so the ways it can be wrong are expensive:
 *
 *   1. THE OPENING BALANCE. Computed from everything dated BEFORE the window,
 *      which means the query behind it must not be date-filtered. Filtering
 *      the history to the selected range is the exact bug the brief names --
 *      it produces an opening balance of whatever the master was last typed
 *      as, and a closing figure wrong by the whole of the year before.
 *
 *   2. THE SIGN'S MEANING. Positive is Dr on both sides of the book
 *      (lib/balance.mjs), but a Dr balance is money owed TO the firm by a
 *      customer and money owed BY the firm's supplier back to it. Printing a
 *      payable as a receivable is how an invoice gets paid twice.
 *
 *   3. WHICH SIDE A PARTY IS ON. From the chart of accounts, never from the
 *      sign of the balance. A customer who has paid in advance has a credit
 *      balance and is still a customer.
 *
 *   4. RECONCILIATION. opening + debits - credits = closing. It cannot fail
 *      while `accountBook` computes all four, which is why it is asserted:
 *      the day it does fail, something has started rounding twice, and a
 *      statement is the last place anybody would notice by eye.
 *
 *   5. THE SUMMARY AGREEING WITH THE DETAIL. The month view collapses the
 *      rows; its last month's closing figure must be the statement's closing
 *      figure, or the two tables in one workbook disagree.
 *
 * The statement is built by calling lib/accountBooks.mjs's `accountBook`
 * unchanged, so these also serve as a check that the sheet a party receives
 * and the A/C Ledger behind it are the same four numbers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { accountBook } from "../lib/accountBooks.mjs";
import {
  MONTHLY_COLUMNS,
  STATEMENT_COLUMNS,
  STATEMENT_FORMATS,
  STATEMENT_SIDES,
  STATEMENT_SIDE_KEYS,
  accountsForSide,
  balanceLine,
  balanceWording,
  invoiceNoOf,
  isDocumentRow,
  isStatementFormat,
  isStatementSide,
  monthWise,
  particularsOf,
  reconcile,
  referenceOf,
  sideOfAccount,
  statement,
  statementMeta,
  statementProblem,
  statementSheets,
  statementSide,
} from "../lib/statements.mjs";
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

const ACME = {
  _id: "c1",
  name: "Acme Traders",
  group: "customer",
  openingBal: 2000,
  gstIn: "07AAACA1111A1Z5",
  city: "Delhi",
  state: "Delhi",
};

const BHARAT = {
  _id: "s1",
  name: "Bharat Steel",
  group: "supplier",
  openingBal: -15000,
  gstIn: "27AAACB2222B1Z6",
  city: "Mumbai",
};

/** A ledger row for the party named. */
const row = (over = {}) => ({
  _id: "r1",
  customerName: "Acme Traders",
  date: new Date("2026-04-05T00:00:00Z"),
  account: "Sales Account",
  paymentType: "Credit",
  debit: 11800,
  credit: 0,
  narration: "By Invoice No: 12",
  ...over,
});

/** April's rows for Acme: a bill before the window, three inside it. */
const ACME_ROWS = [
  row({ _id: "a0", date: new Date("2026-03-20T00:00:00Z"), debit: 5000, narration: "By Invoice No: 7" }),
  row({ _id: "a1", date: new Date("2026-04-05T00:00:00Z"), debit: 11800, narration: "By Invoice No: 12" }),
  row({
    _id: "a2",
    date: new Date("2026-04-09T00:00:00Z"),
    account: "HDFC Bank",
    paymentType: "HDFC Bank",
    debit: 0,
    credit: 5000,
    narration: "Chq 4411 cleared",
  }),
  row({
    _id: "a3",
    date: new Date("2026-04-20T00:00:00Z"),
    debit: 0,
    credit: 1180,
    narration: "By Invoice No: 13",
  }),
];

const APRIL = { from: "2026-04-01", to: "2026-04-30" };

console.log("\n--- the two sides ---");

test("there are exactly two, and each names its chart-of-accounts group", () => {
  assert.deepEqual(STATEMENT_SIDE_KEYS, ["customer", "supplier"]);
  assert.equal(STATEMENT_SIDES.customer.groupCode, 27);
  assert.equal(STATEMENT_SIDES.customer.groupName, "Sundry Debtors");
  assert.equal(STATEMENT_SIDES.supplier.groupCode, 28);
  assert.equal(STATEMENT_SIDES.supplier.groupName, "Sundry Creditors");
  assert.equal(isStatementSide("customer"), true);
  assert.equal(isStatementSide("vendor"), false);
  assert.equal(statementSide("nonsense"), null);
});

test("a party's side comes from its group, legacy spellings included", () => {
  assert.equal(sideOfAccount({ group: "customer" }), "customer");
  assert.equal(sideOfAccount({ group: "Sundry Debtors" }), "customer");
  assert.equal(sideOfAccount({ group: "supplier" }), "supplier");
  assert.equal(sideOfAccount({ group: "Sundry Creditors" }), "supplier");
  // Cash is neither, and an unrecognised group is neither -- not guessed.
  assert.equal(sideOfAccount({ group: "Cash-in-Hand" }), null);
  assert.equal(sideOfAccount({ group: "Mumbai Party" }), null);
  assert.equal(sideOfAccount({}), null);
});

test("the side is NOT taken from the sign of the balance", () => {
  // A customer in credit -- they have paid in advance -- is still a customer,
  // and a supplier we have overpaid is still a supplier.
  assert.equal(sideOfAccount({ group: "customer", openingBal: -9000, lastBal: -9000 }), "customer");
  assert.equal(sideOfAccount({ group: "supplier", openingBal: 4000, lastBal: 4000 }), "supplier");
});

test("the picker offers one side's accounts only, sorted, with their details", () => {
  // Zenith FIRST, so the sort has something to do. A fixture already in
  // alphabetical order cannot tell a sorted list from an unsorted one.
  const accounts = [{ name: "Zenith", group: "customer" }, BHARAT, { name: "Cash", group: "Cash-in-Hand" }, ACME];
  const customers = accountsForSide(accounts, "customer");
  assert.deepEqual(customers.map((a) => a.name), ["Acme Traders", "Zenith"]);
  // `gstIn` is the master's spelling; the picker must still carry it.
  assert.equal(customers[0].gstin, "07AAACA1111A1Z5");
  assert.deepEqual(accountsForSide(accounts, "supplier").map((a) => a.name), ["Bharat Steel"]);
  assert.deepEqual(accountsForSide(accounts, "nonsense"), []);
  // A nameless master row is not an account.
  assert.deepEqual(accountsForSide([{ group: "customer" }], "customer"), []);
});

console.log("\n--- what each row is ---");

test("the document kind is named from the contra account, not from a label", () => {
  // Only an invoice posting puts these two opposite a party, so the contra
  // account is evidence rather than inference.
  assert.equal(particularsOf({ account: "Sales Account", debit: 100, credit: 0 }), "Sales Invoice");
  assert.equal(particularsOf({ account: "Sales Account", debit: 0, credit: 100 }), "Sales Return");
  assert.equal(particularsOf({ account: "Purchase Account", debit: 0, credit: 100 }), "Purchase Bill");
  assert.equal(particularsOf({ account: "Purchase Account", debit: 100, credit: 0 }), "Purchase Return");
});

test("a receipt and a payment are named from OUR OWN narration", () => {
  assert.equal(
    particularsOf({ account: "Cash", debit: 0, credit: 500, narration: "Receipt against Invoice No: 9" }),
    "Receipt"
  );
  assert.equal(
    particularsOf({ account: "Cash", debit: 500, credit: 0, narration: "Payment against Invoice No: 9" }),
    "Payment"
  );
});

test("anything else keeps the contra account rather than inventing a category", () => {
  // A voucher receipt against a bank. Guessing "Receipt" from the sign would
  // be exactly the invented transaction category the brief forbids -- the
  // narration is the user's own free text and says nothing reliable.
  assert.equal(
    particularsOf({ account: "HDFC Bank", debit: 0, credit: 5000, narration: "Chq 4411 cleared" }),
    "HDFC Bank"
  );
  assert.equal(particularsOf({ account: "", debit: 0, credit: 0 }), "(no contra account)");
});

test("a document row is told from a money row", () => {
  assert.equal(isDocumentRow({ account: "Sales Account" }), true);
  assert.equal(isDocumentRow({ account: "Purchase Account" }), true);
  assert.equal(isDocumentRow({ account: "HDFC Bank" }), false);
});

console.log("\n--- the reference number ---");

test("it is read out of the narration our posting path writes", () => {
  assert.equal(referenceOf("By Invoice No: 12"), "12");
  assert.equal(referenceOf("Receipt against Invoice No: 9"), "9");
  assert.equal(referenceOf("By Purchase No. 44"), "44");
  assert.equal(referenceOf("By Invoice No 7"), "7");
  assert.equal(referenceOf(""), "");
  assert.equal(referenceOf("Main account entry"), "");
  // Bounded to digits, so a narration ending in a date is not a reference.
  assert.equal(referenceOf("Settled on 01-04-2026"), "");
});

test("only OUR invoice narrations give a number safe to link to", () => {
  // A voucher narration containing "No: 4411" is a cheque number. Linking it
  // to invoice 4411 would open a stranger's bill.
  assert.equal(invoiceNoOf({ narration: "By Invoice No: 12" }), "12");
  assert.equal(invoiceNoOf({ narration: "Receipt against Invoice No: 9" }), "9");
  assert.equal(invoiceNoOf({ narration: "Chq No: 4411 cleared" }), "");
  assert.equal(invoiceNoOf({ narration: "Adjustment No: 3" }), "");
  // AND the match is anchored at the START. A narration that merely mentions
  // an invoice number -- their reference, not ours -- is not a row this app
  // posted, and linking it would open whichever of OUR bills happens to
  // carry that number.
  assert.equal(invoiceNoOf({ narration: "Settled against their invoice no 99" }), "");
  assert.equal(invoiceNoOf({ narration: "Part of purchase No: 12 last year" }), "");
  assert.equal(invoiceNoOf({}), "");
});

console.log("\n--- the words for a balance ---");

test("the same sign means opposite things on the two sides", () => {
  const custDr = balanceWording(4500, "customer");
  assert.deepEqual([custDr.mode, custDr.magnitude, custDr.owing], ["Dr", 4500, true]);
  assert.match(custDr.phrase, /owed to you/);

  const custCr = balanceWording(-4500, "customer");
  assert.deepEqual([custCr.mode, custCr.owing], ["Cr", false]);
  assert.match(custCr.phrase, /advance/);

  // THE PAIR THAT MATTERS. A supplier's Cr balance is a payable, and the
  // firm owes it -- the same sign that meant an advance a moment ago.
  const suppCr = balanceWording(-15000, "supplier");
  assert.deepEqual([suppCr.mode, suppCr.magnitude, suppCr.owing], ["Cr", 15000, true]);
  assert.match(suppCr.phrase, /owed by you/);

  const suppDr = balanceWording(15000, "supplier");
  assert.deepEqual([suppDr.mode, suppDr.owing], ["Dr", false]);
  assert.match(suppDr.phrase, /advance/);
});

test("an unknown side reads as a customer rather than as a supplier", () => {
  // A bad `side` reaching this far means a URL was edited. Falling back to
  // the supplier reading would print a receivable as a payable, which is the
  // worse of the two wrong answers.
  const odd = balanceWording(4500, "vendor");
  assert.equal(odd.owing, true);
  assert.match(odd.phrase, /owed to you/);
});

test("a nil balance is said in words, not printed as 0.00 Dr", () => {
  const nil = balanceWording(0, "customer");
  assert.equal(nil.owing, false);
  assert.equal(nil.phrase, "Nothing outstanding");
  assert.equal(balanceLine(nil), "Nothing outstanding");
  assert.equal(balanceLine(null), "");
});

test("a balance line carries the figure, the mode and the words", () => {
  assert.equal(balanceLine(balanceWording(-15000, "supplier")), "15000.00 Cr (owed by you)");
});

console.log("\n--- the statement ---");

test("the opening balance comes from before the window, master balance included", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  // 2,000 typed on the master + 5,000 invoiced in March.
  assert.equal(st.opening, 7000);
  assert.equal(st.openingMode, "Dr");
  // The March row is NOT in the window's lines.
  assert.equal(st.lines.length, 3);
  assert.deepEqual(st.lines.map((l) => l.reference), ["12", "", "13"]);
  // And a period that HAS entries is not flagged quiet.
  assert.equal(st.quiet, false);
});

test("it is the same four numbers as the A/C Ledger behind it", () => {
  // The whole design: a statement calls `accountBook` and labels its lines.
  // If these ever diverge, a customer has a sheet that disagrees with the
  // ledger the shop will quote back at them.
  const book = accountBook({ account: ACME, rows: ACME_ROWS, openingBal: ACME.openingBal, ...APRIL });
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  assert.equal(st.opening, book.opening);
  assert.equal(st.closing, book.closing);
  assert.deepEqual(st.totals, book.totals);
  assert.deepEqual(st.lines.map((l) => l.balance), book.lines.map((l) => l.balance));
});

test("the running balance is recomputed, in (date, _id) order", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  assert.deepEqual(st.lines.map((l) => l.balance), [18800, 13800, 12620]);
  assert.deepEqual(st.lines.map((l) => l.srNo), [1, 2, 3]);
  assert.equal(st.closing, 12620);
});

test("two entries on one day are ordered by _id, not left to chance", () => {
  const same = [
    row({ _id: "b", date: new Date("2026-04-05T00:00:00Z"), debit: 0, credit: 300, account: "Cash" }),
    row({ _id: "a", date: new Date("2026-04-05T00:00:00Z"), debit: 1000, credit: 0 }),
  ];
  const st = statement({ account: { ...ACME, openingBal: 0 }, side: "customer", rows: same, ...APRIL });
  assert.deepEqual(st.lines.map((l) => l._id), ["a", "b"]);
  assert.deepEqual(st.lines.map((l) => l.balance), [1000, 700]);
});

test("the closing balance reconciles with the opening plus the movements", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  assert.equal(st.reconciliation.balanced, true);
  assert.equal(st.reconciliation.difference, 0);
  assert.equal(st.reconciliation.expected, st.closing);
  // 7000 + 11800 - 6180.
  assert.equal(st.opening + st.totals.debit - st.totals.credit, st.closing);
});

test("a discrepancy is reported rather than thrown", () => {
  // A one-paisa statement is still worth showing, with the difference
  // printed, over an error page.
  const broken = reconcile({ opening: 100, totals: { debit: 50, credit: 0 }, closing: 150.01 });
  assert.equal(broken.balanced, false);
  assert.equal(broken.difference, 0.01);
});

test("a back-dated entry lands in order and moves every balance after it", () => {
  const withBackdate = [
    ...ACME_ROWS,
    row({ _id: "a4", date: new Date("2026-04-06T00:00:00Z"), debit: 1000, credit: 0, narration: "By Invoice No: 14" }),
  ];
  const st = statement({ account: ACME, side: "customer", rows: withBackdate, ...APRIL });
  // Slotted between the 5th and the 9th, by date -- not appended.
  assert.deepEqual(st.lines.map((l) => l.reference), ["12", "14", "", "13"]);
  assert.deepEqual(st.lines.map((l) => l.balance), [18800, 19800, 14800, 13620]);
  assert.equal(st.reconciliation.balanced, true);
});

test("a party with no entries in the period still gets a statement", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, from: "2026-06-01", to: "2026-06-30" });
  assert.equal(st.quiet, true);
  assert.equal(st.lines.length, 0);
  // The opening carries everything up to June and the closing equals it --
  // "no transactions" and "no balance" are different answers.
  assert.equal(st.opening, 12620);
  assert.equal(st.closing, 12620);
  assert.deepEqual(st.totals, { debit: 0, credit: 0 });
  assert.equal(st.reconciliation.balanced, true);
});

test("a party with nothing at all is nil, not broken", () => {
  const st = statement({ account: { name: "New Co", group: "customer" }, side: "customer", rows: [], ...APRIL });
  assert.equal(st.opening, 0);
  assert.equal(st.closing, 0);
  assert.equal(st.quiet, true);
  assert.equal(st.closingWording.phrase, "Nothing outstanding");
});

test("a return credits the customer and is named a return", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  const ret = st.lines.find((l) => l.reference === "13");
  assert.equal(ret.particulars, "Sales Return");
  assert.equal(ret.credit, 1180);
  assert.equal(ret.debit, 0);
});

test("a partial receipt leaves the rest outstanding", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  // 11,800 billed, 5,000 received, 1,180 returned, against a 7,000 opening.
  assert.equal(st.closing, 12620);
  assert.equal(st.closingWording.owing, true);
});

console.log("\n--- the supplier side ---");

const BHARAT_ROWS = [
  {
    _id: "b1",
    customerName: "Bharat Steel",
    date: new Date("2026-04-04T00:00:00Z"),
    account: "Purchase Account",
    paymentType: "Credit",
    debit: 0,
    credit: 59000,
    narration: "By Purchase No: 31",
  },
  {
    _id: "b2",
    customerName: "Bharat Steel",
    date: new Date("2026-04-18T00:00:00Z"),
    account: "HDFC Bank",
    paymentType: "HDFC Bank",
    debit: 40000,
    credit: 0,
    narration: "Payment against Invoice No: 31",
  },
  {
    _id: "b3",
    customerName: "Bharat Steel",
    date: new Date("2026-04-26T00:00:00Z"),
    account: "Purchase Account",
    paymentType: "Credit",
    debit: 2360,
    credit: 0,
    narration: "By Purchase No: 32",
  },
];

test("a supplier statement reads bills as credits and payments as debits", () => {
  const st = statement({ account: BHARAT, side: "supplier", rows: BHARAT_ROWS, ...APRIL });
  assert.deepEqual(st.lines.map((l) => l.particulars), [
    "Purchase Bill",
    "Payment",
    "Purchase Return",
  ]);
  assert.deepEqual(st.lines.map((l) => [l.debit, l.credit]), [
    [0, 59000],
    [40000, 0],
    [2360, 0],
  ]);
});

test("and says the firm owes the money, not the other way round", () => {
  const st = statement({ account: BHARAT, side: "supplier", rows: BHARAT_ROWS, ...APRIL });
  // -15,000 opening - 59,000 + 40,000 + 2,360.
  assert.equal(st.opening, -15000);
  assert.equal(st.closing, -31640);
  assert.equal(st.closingMode, "Cr");
  assert.equal(st.closingWording.owing, true);
  assert.match(st.closingWording.phrase, /owed by you/);
  assert.equal(st.reconciliation.balanced, true);
  // THE REGRESSION THAT MATTERS: the same figures on the customer side would
  // read as an advance the firm is holding, which is the opposite statement.
  assert.equal(balanceWording(st.closing, "customer").owing, false);
});

test("the OPENING balance gets the supplier wording as well as the closing", () => {
  // Both ends of the sheet. An opening printed with the customer reading
  // would say the supplier owes the firm 15,000 at the top of the page and
  // that the firm owes them 31,640 at the bottom.
  const st = statement({ account: BHARAT, side: "supplier", rows: BHARAT_ROWS, ...APRIL });
  assert.equal(st.openingWording.owing, true);
  assert.match(st.openingWording.phrase, /owed by you/);
  assert.equal(balanceLine(st.openingWording), "15000.00 Cr (owed by you)");
});

test("an overpaid supplier is a debit balance, and an advance", () => {
  const overpaid = statement({
    account: { ...BHARAT, openingBal: 0 },
    side: "supplier",
    rows: [BHARAT_ROWS[1]],
    ...APRIL,
  });
  assert.equal(overpaid.closing, 40000);
  assert.equal(overpaid.closingMode, "Dr");
  assert.equal(overpaid.closingWording.owing, false);
  assert.match(overpaid.closingWording.phrase, /advance/);
});

console.log("\n--- the month summary ---");

test("it agrees with the detail it collapses", () => {
  const rows = [
    ...ACME_ROWS,
    row({ _id: "a5", date: new Date("2026-05-10T00:00:00Z"), debit: 2000, narration: "By Invoice No: 20" }),
    row({ _id: "a6", date: new Date("2026-06-02T00:00:00Z"), debit: 0, credit: 500, account: "Cash" }),
  ];
  const st = statement({ account: ACME, side: "customer", rows, from: "2026-04-01", to: "2026-06-30" });
  const months = monthWise(st);

  assert.deepEqual(months.map((m) => m.label), ["Apr 2026", "May 2026", "Jun 2026"]);

  // THE INVARIANT: a summary that quietly differs from its detail is worse
  // than no summary. EVERY month's closing is the running balance after its
  // own last entry -- checked per month, not only on the last one, because
  // the last month here holds a single entry and a summed or
  // first-entry-wins balance would agree with the right answer there by
  // accident. April holds three.
  assert.equal(months[0].entries, 3);
  for (const month of months) {
    const inMonth = st.lines.filter((l) => l.date.toISOString().slice(0, 7) === `${String(month.month).slice(0, 4)}-${String(month.month).slice(4)}`);
    assert.equal(month.balance, inMonth[inMonth.length - 1].balance, month.label);
    assert.equal(month.entries, inMonth.length, month.label);
  }
  // ...and the last month's closing is the statement's closing.
  assert.equal(months[months.length - 1].balance, st.closing);
  // ...and the columns sum to the statement's own totals.
  assert.equal(months.reduce((t, m) => t + m.debit, 0), st.totals.debit);
  assert.equal(months.reduce((t, m) => t + m.credit, 0), st.totals.credit);
  assert.equal(months.reduce((t, m) => t + m.entries, 0), st.lines.length);
});

test("a month with nothing in it is not invented", () => {
  const rows = [
    row({ _id: "x1", date: new Date("2026-04-05T00:00:00Z"), debit: 100 }),
    row({ _id: "x2", date: new Date("2026-06-05T00:00:00Z"), debit: 100 }),
  ];
  const st = statement({ account: ACME, side: "customer", rows, from: "2026-04-01", to: "2026-06-30" });
  // A gap says nothing was bought and nothing was paid, which is information.
  assert.deepEqual(monthWise(st).map((m) => m.label), ["Apr 2026", "Jun 2026"]);
});

test("months are grouped by the IST day, not the server's", () => {
  // 31 March 2026, 19:00 UTC is 1 April, 00:30 IST. Grouped by UTC this is
  // March; the bill is an April bill.
  const rows = [row({ _id: "m1", date: new Date("2026-03-31T19:00:00Z"), debit: 100 })];
  const st = statement({ account: { ...ACME, openingBal: 0 }, side: "customer", rows, ...APRIL });
  assert.deepEqual(monthWise(st).map((m) => m.label), ["Apr 2026"]);
});

test("it takes a statement or a bare line array", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  assert.deepEqual(monthWise(st), monthWise(st.lines));
  assert.deepEqual(monthWise([]), []);
  assert.deepEqual(monthWise(null), []);
});

console.log("\n--- validation ---");

test("a party on the wrong side is refused, with the right statement named", () => {
  assert.match(
    statementProblem({ side: "customer", account: BHARAT, ...APRIL }),
    /Sundry Creditors.*supplier statement/
  );
  assert.equal(statementProblem({ side: "supplier", account: BHARAT, ...APRIL }), null);
  assert.equal(statementProblem({ side: "customer", account: ACME, ...APRIL }), null);
});

test("an account in no recognised group is refused rather than guessed", () => {
  assert.match(
    statementProblem({ side: "customer", account: { name: "Mumbai Party", group: "Mumbai" }, ...APRIL }),
    /not a group in the chart of accounts/
  );
});

test("a missing side, party, format or period is refused", () => {
  assert.match(statementProblem({ ...APRIL }), /customer or a supplier/);
  assert.match(statementProblem({ side: "customer", ...APRIL }), /Pick a customer/);
  assert.match(statementProblem({ side: "supplier", ...APRIL }), /Pick a supplier/);
  assert.match(
    statementProblem({ side: "customer", account: ACME, format: "pretty", ...APRIL }),
    /not a statement format/
  );
  // The period rules are lib/reportPeriods.mjs's, not a second copy.
  assert.match(statementProblem({ side: "customer", account: ACME, from: "2026-05-01", to: "2026-04-01" }), /after its end/);
  assert.match(statementProblem({ side: "customer", account: ACME, from: "", to: "" }), /both dates/i);
});

test("a party given as a bare name skips the side check rather than failing it", () => {
  // The picker sends a name; the route looks the record up and passes THAT,
  // which is when the side is checked. A name alone carries no group, and
  // refusing it would make the route's own error unreachable.
  assert.equal(statementProblem({ side: "customer", account: "Acme Traders", ...APRIL }), null);
});

test("only the two formats are formats", () => {
  assert.deepEqual(STATEMENT_FORMATS, ["detailed", "monthly"]);
  assert.equal(isStatementFormat("monthly"), true);
  assert.equal(isStatementFormat("summary"), false);
  assert.equal(isStatementFormat(""), false);
});

console.log("\n--- the header and the downloads ---");

test("the firm comes from the record passed in, never hardcoded", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  const meta = statementMeta({
    statement: st,
    company: { name: "Shah Brothers", gstin: "07AAACS9999S1Z1" },
    companyAddressLine: "12 Lane, Delhi - 110001",
  });
  const byLabel = Object.fromEntries(meta.map((m) => [m.label, m.value]));
  assert.equal(byLabel.Firm, "Shah Brothers");
  assert.equal(byLabel.Address, "12 Lane, Delhi - 110001");
  assert.equal(byLabel.GSTIN, "07AAACS9999S1Z1");
  assert.equal(byLabel.Customer, "Acme Traders");
  assert.equal(byLabel["Customer GSTIN"], "07AAACA1111A1Z5");
  assert.equal(byLabel.Period, "01-04-2026 to 30-04-2026");
  assert.equal(byLabel.Currency, "INR");
});

test("a firm with no GSTIN exports no GSTIN line", () => {
  const st = statement({ account: { name: "New Co", group: "customer" }, side: "customer", rows: [], ...APRIL });
  const meta = statementMeta({ statement: st, company: { name: "Shah Brothers" } });
  assert.equal(meta.some((m) => m.label === "GSTIN"), false);
  assert.equal(meta.some((m) => m.label === "Customer GSTIN"), false);
});

test("a supplier statement's header says Supplier, not Customer", () => {
  const st = statement({ account: BHARAT, side: "supplier", rows: BHARAT_ROWS, ...APRIL });
  const meta = statementMeta({ statement: st, company: { name: "Shah Brothers" } });
  assert.ok(meta.some((m) => m.label === "Supplier" && m.value === "Bharat Steel"));
  assert.equal(meta.some((m) => m.label === "Customer"), false);
});

test("the download is two worksheets, the chosen view first", () => {
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  const detailed = statementSheets({ statement: st, company: { name: "X" }, format: "detailed" });
  assert.deepEqual(detailed.map((s) => s.name), ["Entries", "Month summary"]);
  const monthly = statementSheets({ statement: st, company: { name: "X" }, format: "monthly" });
  // The CSV takes the FIRST sheet, so it must match what is on screen.
  assert.deepEqual(monthly.map((s) => s.name), ["Month summary", "Entries"]);
});

test("the export has every row, not a page of them", () => {
  const many = Array.from({ length: 150 }, (_, i) =>
    row({ _id: `p${String(i).padStart(3, "0")}`, date: new Date("2026-04-10T00:00:00Z"), debit: 10, credit: 0 })
  );
  const st = statement({ account: { ...ACME, openingBal: 0 }, side: "customer", rows: many, ...APRIL });
  const [entries] = statementSheets({ statement: st, company: { name: "X" }, format: "detailed" });
  // The screen pages at 100; the download must not.
  assert.equal(entries.rows.length, 150);
  assert.equal(entries.totals.debit, 1500);
});

test("one column list drives the screen, the CSV and the workbook", () => {
  // Each one carries the type the .xlsx writer needs, so the two downloads
  // cannot disagree about what a column is called.
  for (const column of [...STATEMENT_COLUMNS, ...MONTHLY_COLUMNS]) {
    assert.ok(column.key, "a column with no key");
    assert.ok(column.label, `${column.key} has no label`);
    assert.ok(["text", "date", "money", "qty", "int"].includes(column.type), `${column.key}: ${column.type}`);
  }
  assert.deepEqual(
    STATEMENT_COLUMNS.map((c) => c.label),
    ["Date", "Particulars", "Reference", "Against", "Narration", "Debit", "Credit", "Balance", "Dr/Cr"]
  );
  // The money columns are typed MONEY, not merely typed. A figure column
  // typed text exports as a string, and a column of strings cannot be
  // totalled -- which is the whole reason to offer .xlsx beside .csv.
  for (const key of ["debit", "credit", "balance"]) {
    assert.equal(STATEMENT_COLUMNS.find((c) => c.key === key)?.type, "money", key);
    assert.equal(MONTHLY_COLUMNS.find((c) => c.key === key)?.type, "money", `monthly ${key}`);
  }
  assert.equal(STATEMENT_COLUMNS.find((c) => c.key === "date")?.type, "date");
  assert.equal(MONTHLY_COLUMNS.find((c) => c.key === "entries")?.type, "int");
  const st = statement({ account: ACME, side: "customer", rows: ACME_ROWS, ...APRIL });
  // Every column key resolves on a real line.
  for (const column of STATEMENT_COLUMNS) {
    assert.ok(column.key in st.lines[0], `no line field for ${column.key}`);
  }
  for (const column of MONTHLY_COLUMNS) {
    assert.ok(column.key in monthWise(st)[0], `no month field for ${column.key}`);
  }
});

console.log("\n--- security and wiring ---");

test("the statement is behind the same permission as the ledger it is built on", () => {
  // A role kept out of the A/C Ledger must not get the same rows from a
  // statement -- and the export is the same route, so it inherits this.
  assert.equal(permissionForPath("/api/statement"), "ledger:read");
  assert.equal(permissionForPath("/statement"), "ledger:read");
  assert.equal(permissionForPath("/api/account-book"), permissionForPath("/api/statement"));
  assert.equal(canAccessPath("owner", "/api/statement"), true);
  assert.equal(canAccessPath("accountant", "/api/statement"), true);
  assert.equal(canAccessPath("biller", "/api/statement"), false);
});

test("the route is tenant-scoped and reads the firm from the session", () => {
  const route = read("../app/api/statement/route.js");
  assert.match(route, /export const GET = tenantRoute\(handleGET\);/);
  // The firm on the letterhead comes from the session's companyId, never
  // from anything the client sent.
  assert.match(route, /Company\.findById\(auth\.companyId\)/);
  assert.equal(/searchParams\.get\(["']companyId["']\)/.test(route), false);
});

test("the ledger query is NOT date-filtered, which is what makes the opening right", () => {
  const route = read("../app/api/statement/route.js");
  const find = route.slice(route.indexOf("Ledger.find("), route.indexOf(".sort({ date: 1"));
  // A date filter here would produce an opening balance of whatever the
  // master was last typed as -- the exact bug the brief names.
  assert.equal(/date:\s*\{/.test(find), false, "the statement query grew a date filter");
  assert.match(find, /customerName: found\.name/);
  // And matched on customerName ONLY: `account` is the contra side of the
  // same row, and matching both counts the same money twice.
  assert.equal(/account:\s*\{?\s*\$?in/.test(find), false);
});

test("the route validates every parameter server-side", () => {
  const route = read("../app/api/statement/route.js");
  for (const guard of ["isStatementSide", "isReportFormat", "isStatementFormat", "isPreset", "statementProblem"]) {
    assert.ok(route.includes(guard), `the route does not call ${guard}`);
  }
});

test("the statement does its own arithmetic nowhere", () => {
  const src = read("../lib/statements.mjs");
  // It calls accountBook and labels the result. A `let running` in here would
  // be a second running-balance implementation, which is how a statement
  // comes to disagree with the ledger.
  assert.match(src, /accountBook\(\{/);
  assert.equal(/let running/.test(src), false, "statements.mjs grew its own running balance");
  assert.equal(/import mongoose/.test(src), false);
});

test("the page lays out the server's figures and computes none", () => {
  const page = read("../app/statement/page.js");
  // One slice, for the pager. No reduce, no running total.
  assert.equal(/\.reduce\(/.test(page), false, "the page grew its own arithmetic");
  assert.match(page, /rows\.slice\(page \* PAGE_SIZE/);
  // And it says, on screen, that a download is not the page.
  assert.match(page, /A download has every row/);
});

test("both downloads go back to the same route", () => {
  const page = read("../app/statement/page.js");
  assert.match(page, /params\.set\('format', format\)/);
  assert.match(page, /download\('xlsx'\)/);
  assert.match(page, /download\('csv'\)/);
  // Not built in the browser from the page's own rows, which would export
  // the page rather than the report.
  assert.equal(/new Blob\(/.test(page), false);
});

console.log(`\n  ${passed} checks passed\n`);
