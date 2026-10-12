/**
 * Fixture tests for settling a receipt against particular bills.
 *
 *   node scripts/bill-adjust.test.mjs
 *
 * Sigfa's "Against Bill", and its rules are cited where they are copied:
 * "Adjustment on FIFO Basis", "Adjusted Amount Exceeds Amount to be
 * Adjusted", "Bal. Amount Can't Be Less Than Adjusted Amt i.e.", "No Pending
 * Bills Found", and both directions -- "Payment Received - Bill Adjustment"
 * and "Payment Paid - Bill Adjustment". Its own client has 1 row in OUTBILL
 * and 0 in OUTBILL1, so none of this is measured against their data; it is
 * measured against arithmetic.
 *
 * Four failure modes, each of which loses money quietly rather than throwing:
 *
 *   1. THE WRONG DIRECTION. Money coming back from a customer settles SALE
 *      invoices; money paid out settles PURCHASE invoices. Offering the wrong
 *      set lets a receipt be adjusted against a bill the firm owes, and the
 *      two balance to the same total so nothing looks wrong.
 *
 *   2. SETTLING A BILL TWICE. Outstanding is derived, so the figure has to
 *      net off every allocation ever made against that bill -- and, when a
 *      voucher is being edited, must NOT net off its own, or re-saving an
 *      untouched voucher refuses itself.
 *
 *   3. OVER-ALLOCATING. Two separate limits, and both of Sigfa's messages:
 *      more than the line holds, and more than the bill still owes.
 *
 *   4. THE EPSILON. Money settles to the paisa. A bill left owing a
 *      hundredth of a rupee is settled; one left owing two paise is not.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MONEY_EPSILON,
  adjustmentSummary,
  ageInDays,
  allocatedByBill,
  allocatedTotal,
  allocationProblems,
  billKey,
  billTypeFor,
  fifoAllocate,
  emptyReason,
  lineAmount,
  normalizeAllocations,
  nothingToAdjust,
  onAccount,
  openBills,
  outstandingOf,
} from "../lib/billAdjust.mjs";
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

/** Read a project file, for the wiring checks. Declared with the helper. */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const NOW = Date.parse("2026-10-11T00:00:00Z");

const invoice = (over = {}) => ({
  invoiceNo: 1,
  type: "Sale",
  return: false,
  date: new Date("2026-06-01T00:00:00Z"),
  finalAmount: 5000,
  received: 0,
  balanceDue: 5000,
  customer: { name: "Acme Traders" },
  ...over,
});

const threeBills = (allocated = new Map()) =>
  openBills({
    invoices: [
      invoice({ invoiceNo: 1, balanceDue: 5000, date: new Date("2026-06-01T00:00:00Z") }),
      invoice({ invoiceNo: 2, balanceDue: 3000, date: new Date("2026-07-15T00:00:00Z") }),
      invoice({ invoiceNo: 3, balanceDue: 2000, date: new Date("2026-09-01T00:00:00Z") }),
    ],
    allocatedByInvoice: allocated,
    type: "Sale",
    now: NOW,
  });

const bill = (list, no) => list.find((b) => b.invoiceNo === no);

console.log("\n--- which bills a line settles ---");

test("a credit to a party settles SALE invoices", () => {
  // A sale debits the party, so money coming BACK is a credit.
  assert.equal(billTypeFor({ debit: 0, credit: 5000 }), "Sale");
});

test("a debit to a party settles PURCHASE invoices", () => {
  assert.equal(billTypeFor({ debit: 5000, credit: 0 }), "Purchase");
});

test("a line that is neither, or both, settles nothing", () => {
  // There is no honest guess to make, and guessing wrong offers bills the
  // firm owes against money it received -- which balances to the same total,
  // so nothing on the screen would look wrong.
  assert.equal(billTypeFor({ debit: 0, credit: 0 }), null);
  assert.equal(billTypeFor({ debit: 100, credit: 100 }), null);
  assert.equal(billTypeFor({}), null);
  assert.equal(billTypeFor(null), null);
});

test("the amount is the magnitude, whichever side it is on", () => {
  assert.equal(lineAmount({ debit: 0, credit: 5000 }), 5000);
  assert.equal(lineAmount({ debit: 5000, credit: 0 }), 5000);
  assert.equal(lineAmount({}), 0);
  // A line carrying both sides nets to nothing -- it is the DIFFERENCE, not
  // the sum. Summing them would offer 10,000 to adjust where no money moved,
  // and every single-sided line in the fixtures agrees with either formula.
  assert.equal(lineAmount({ debit: 5000, credit: 5000 }), 0);
  assert.equal(lineAmount({ debit: 5000, credit: 2000 }), 3000);
});

console.log("\n--- what is outstanding ---");

test("outstanding starts from balanceDue, not the invoice total", () => {
  // Money taken at the counter is already accounted for by the invoice's own
  // receipt leg. Starting from finalAmount would ask the party to pay it
  // twice.
  const inv = invoice({ finalAmount: 5000, received: 2000, balanceDue: 3000 });
  assert.equal(outstandingOf(inv, 0), 3000);
  assert.notEqual(outstandingOf(inv, 0), 5000);
});

test("everything already settled is netted off", () => {
  assert.equal(outstandingOf(invoice({ balanceDue: 5000 }), 1500), 3500);
});

test("a bill settled to the paisa drops off the list", () => {
  const list = openBills({
    invoices: [invoice({ balanceDue: 5000 })],
    allocatedByInvoice: new Map([["Sale#1", 5000]]),
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(list, [], "a list that kept it would grow forever");
});

test("a bill owing a fraction of a paisa is settled; two paise is not", () => {
  const nearly = openBills({
    invoices: [invoice({ balanceDue: 5000 })],
    allocatedByInvoice: new Map([["Sale#1", 4999.999]]),
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(nearly, []);

  const owing = openBills({
    invoices: [invoice({ balanceDue: 5000 })],
    allocatedByInvoice: new Map([["Sale#1", 4999.98]]),
    type: "Sale",
    now: NOW,
  });
  assert.equal(owing.length, 1);
  assert.equal(owing[0].outstanding, 0.02);
});

test("the list is oldest first", () => {
  // FIFO settles in this order, and a chase list that is not in age order is
  // not a chase list.
  //
  // The invoices go IN newest first. A fixture already in age order cannot
  // tell a sort from no sort at all -- deleting the sort passed.
  const list = openBills({
    invoices: [
      invoice({ invoiceNo: 3, balanceDue: 2000, date: new Date("2026-09-01T00:00:00Z") }),
      invoice({ invoiceNo: 1, balanceDue: 5000, date: new Date("2026-06-01T00:00:00Z") }),
      invoice({ invoiceNo: 2, balanceDue: 3000, date: new Date("2026-07-15T00:00:00Z") }),
    ],
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(list.map((b) => b.invoiceNo), [1, 2, 3]);

  // Two bills of the same age fall back to the invoice number, so the order
  // is total rather than merely sorted.
  const sameDay = openBills({
    invoices: [
      invoice({ invoiceNo: 9, date: new Date("2026-06-01T00:00:00Z") }),
      invoice({ invoiceNo: 4, date: new Date("2026-06-01T00:00:00Z") }),
    ],
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(sameDay.map((b) => b.invoiceNo), [4, 9]);
});

test("only the asked-for side is offered", () => {
  const list = openBills({
    invoices: [invoice({ invoiceNo: 1, type: "Sale" }), invoice({ invoiceNo: 2, type: "Purchase" })],
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(list.map((b) => b.invoiceNo), [1]);
});

test("credit notes are left out", () => {
  // A sale return is a credit note. Including it with a negative outstanding
  // would let a receipt be allocated to a negative bill, which reads as
  // settling a debt by taking more money. Sigfa gives that its own screen,
  // "Cross Adjustment".
  // The return here owes a POSITIVE 800, which is how a credit note raised
  // as its own document looks. A negative one is excluded by the
  // outstanding filter whether the return flag is read or not, so a fixture
  // using -800 tests nothing: dropping the flag entirely still passed.
  const list = openBills({
    invoices: [invoice({ invoiceNo: 1 }), invoice({ invoiceNo: 2, return: true, balanceDue: 800 })],
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(list.map((b) => b.invoiceNo), [1]);
});

test("what is already settled is shown beside what is left", () => {
  const list = threeBills(new Map([["Sale#1", 1000]]));
  assert.equal(bill(list, 1).allocated, 1000);
  assert.equal(bill(list, 1).balanceDue, 5000);
  assert.equal(bill(list, 1).outstanding, 4000);
});

test("a bill is keyed by type AND number", () => {
  // Sale 7 and purchase 7 are different bills. Keying on the number alone
  // would net a supplier's bill against a customer's.
  assert.equal(billKey({ invoiceType: "Sale", invoiceNo: 7 }), "Sale#7");
  assert.notEqual(billKey({ invoiceType: "Sale", invoiceNo: 7 }), billKey({ invoiceType: "Purchase", invoiceNo: 7 }));
  assert.equal(billKey({ type: "Sale", invoiceNo: 7 }), "Sale#7", "either spelling of the field");
});

console.log("\n--- age ---");

test("age is in whole days, and never negative", () => {
  assert.equal(ageInDays("2026-10-01", NOW), 10);
  assert.equal(ageInDays("2026-10-11", NOW), 0);
  assert.equal(ageInDays("2026-12-01", NOW), 0, "a future-dated bill is not aged");
  assert.equal(ageInDays(null, NOW), 0);
});

test("age is counted in Delhi's days, not the server's", () => {
  // 7pm UTC is already the next day in Delhi. The container runs on
  // Asia/Calcutta and Vercel runs UTC, so a local-clock comparison gives two
  // answers -- the measurement is in lib/accountBooks.mjs.
  const src = read("../lib/billAdjust.mjs");
  assert.ok(/istDayNumber/.test(src));
  for (const bad of ["setHours(", "getDate(", "getMonth(", "getFullYear(", "toDateString("]) {
    assert.equal(src.includes(bad), false, `${bad} reads the server's clock`);
  }
});

console.log("\n--- FIFO (Sigfa: Adjustment on FIFO Basis) ---");

test("the oldest bills are filled first", () => {
  const out = fifoAllocate({ credit: 6000 }, threeBills());
  assert.deepEqual(out.map((a) => [a.invoiceNo, a.amount]), [[1, 5000], [2, 1000]]);
});

test("FIFO sorts for itself rather than trusting the caller", () => {
  // It is the whole meaning of the word. Handed the list backwards, it must
  // still start with the oldest.
  const reversed = [...threeBills()].reverse();
  const out = fifoAllocate({ credit: 6000 }, reversed);
  assert.equal(out[0].invoiceNo, 1);
});

test("what cannot be allocated stays on account", () => {
  // Sigfa does this, and it is what anybody expects from a round-figure
  // payment. A tick that demanded every rupee be allocated would be unusable.
  const bills = threeBills();
  const out = fifoAllocate({ credit: 99999 }, bills);
  assert.equal(allocatedTotal(out), 10000, "the whole outstanding, and no more");
  assert.equal(onAccount({ credit: 99999 }, out), 89999);
});

test("an exact payment leaves nothing on account", () => {
  const out = fifoAllocate({ credit: 10000 }, threeBills());
  assert.equal(onAccount({ credit: 10000 }, out), 0);
  assert.equal(adjustmentSummary({ credit: 10000 }, out, threeBills()).fullyAllocated, true);
});

test("FIFO against no bills allocates nothing", () => {
  assert.deepEqual(fifoAllocate({ credit: 5000 }, []), []);
});

test("a line with no amount allocates nothing", () => {
  assert.deepEqual(fifoAllocate({ credit: 0 }, threeBills()), []);
});

test("the on-account figure is never negative", () => {
  // Over-allocating is refused, so a negative here would be a figure nobody
  // should be shown.
  assert.equal(onAccount({ credit: 100 }, [{ invoiceNo: 1, amount: 500 }]), 0);
});

console.log("\n--- the three refusals ---");

test("Sigfa: Adjusted Amount Exceeds Amount to be Adjusted", () => {
  const problems = allocationProblems({
    line: { credit: 1000 },
    allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 4000 }],
    bills: threeBills(),
  });
  assert.ok(problems.some((p) => /exceeds the 1000\.00 on this line/.test(p)));
});

test("Sigfa: Bal. Amount Can't Be Less Than Adjusted Amt", () => {
  const problems = allocationProblems({
    line: { credit: 99999 },
    allocations: [{ invoiceNo: 2, invoiceType: "Sale", amount: 9000 }],
    bills: threeBills(),
  });
  assert.ok(problems.some((p) => /only 3000\.00 outstanding/.test(p)));
});

test("Sigfa: No Pending Bills Found", () => {
  assert.equal(nothingToAdjust([]), true);
  assert.equal(nothingToAdjust(threeBills()), false);
});

test("a bill that is not this party's is refused", () => {
  const problems = allocationProblems({
    line: { credit: 1000 },
    allocations: [{ invoiceNo: 99, invoiceType: "Sale", amount: 100 }],
    bills: threeBills(),
  });
  assert.ok(problems.some((p) => /not an open bill for this party/.test(p)));
});

test("the same bill twice is refused", () => {
  // Summing them silently would let the pair exceed the bill while each row
  // passed the per-bill check.
  const problems = allocationProblems({
    line: { credit: 6000 },
    allocations: [
      { invoiceNo: 1, invoiceType: "Sale", amount: 3000 },
      { invoiceNo: 1, invoiceType: "Sale", amount: 3000 },
    ],
    bills: threeBills(),
  });
  assert.ok(problems.some((p) => /appears twice/.test(p)));
});

test("a zero or negative adjustment is refused", () => {
  for (const amount of [0, -100]) {
    const problems = allocationProblems({
      line: { credit: 1000 },
      allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount }],
      bills: threeBills(),
    });
    assert.ok(problems.some((p) => /more than zero/.test(p)), `amount ${amount}`);
  }
});

test("adjusting a line with no amount is refused", () => {
  const problems = allocationProblems({
    line: { credit: 0 },
    allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 100 }],
    bills: threeBills(),
  });
  assert.ok(problems.some((p) => /no amount to adjust/.test(p)));
});

test("allocating nothing is always fine", () => {
  // `againstBill` is a tick, not a requirement.
  assert.deepEqual(allocationProblems({ line: { credit: 5000 }, allocations: [], bills: threeBills() }), []);
  assert.deepEqual(allocationProblems({ line: { credit: 0 }, allocations: [], bills: [] }), []);
});

test("a correct allocation has nothing wrong with it", () => {
  assert.deepEqual(
    allocationProblems({
      line: { credit: 6000 },
      allocations: fifoAllocate({ credit: 6000 }, threeBills()),
      bills: threeBills(),
    }),
    []
  );
});

test("settling a bill to the exact paisa is allowed", () => {
  // The epsilon has to let the boundary through, or a bill can never be
  // closed by an exact payment.
  const bills = threeBills();
  assert.deepEqual(
    allocationProblems({
      line: { credit: 5000 },
      allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: bill(bills, 1).outstanding }],
      bills,
    }),
    []
  );
});

test("the exact paisa is allowed on an amount that is not round", () => {
  // ROUND NUMBERS CANNOT TEST MONEY ROUNDING. The tolerance is added, and
  // subtracting it instead -- the mutation -- is invisible on 5000: in
  // binary, round2(5000 - 0.005) comes back as 5000, so the comparison does
  // not change. On 1234.56 it comes back as 1234.55, and an exact settlement
  // of a bill like that would be refused. Roughly half of real bill amounts
  // behave the second way.
  const bills = openBills({
    invoices: [invoice({ invoiceNo: 1, finalAmount: 1234.56, balanceDue: 1234.56 })],
    type: "Sale",
    now: NOW,
  });
  assert.equal(bills[0].outstanding, 1234.56);

  // Exact on the bill AND exact on the line, so both tolerances are pointed
  // outwards by this one case.
  assert.deepEqual(
    allocationProblems({
      line: { credit: 1234.56 },
      allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 1234.56 }],
      bills,
    }),
    []
  );

  // And one paisa over is still refused, so the tolerance has not simply
  // been widened into uselessness.
  assert.equal(
    allocationProblems({
      line: { credit: 2000 },
      allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 1234.57 }],
      bills,
    }).length,
    1
  );

  // The same again for the LINE total, which needs a bill big enough not to
  // be the thing that refuses it -- otherwise the bill check does the work
  // and the line check is never exercised at all.
  const big = openBills({
    invoices: [invoice({ invoiceNo: 1, finalAmount: 50000, balanceDue: 50000 })],
    type: "Sale",
    now: NOW,
  });
  assert.deepEqual(
    allocationProblems({
      line: { credit: 1234.56 },
      allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 1234.56 }],
      bills: big,
    }),
    []
  );
  assert.equal(
    allocationProblems({
      line: { credit: 1234.56 },
      allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 1234.57 }],
      bills: big,
    }).length,
    1,
    "a paisa more than the line carries is not on the line"
  );
});

console.log("\n--- cleaning what the form sent ---");

test("the bill's own type is used, never the request's", () => {
  // A client that could name the type could allocate a receipt against a
  // purchase invoice.
  const out = normalizeAllocations(
    [{ invoiceNo: 1, invoiceType: "Purchase", amount: 100 }],
    threeBills()
  );
  assert.equal(out[0].invoiceType, "Sale");
});

test("the bill's date is copied onto the allocation", () => {
  const out = normalizeAllocations([{ invoiceNo: 1, amount: 100 }], threeBills());
  assert.ok(out[0].invoiceDate, "a printed adjustment has to keep saying what it said");
});

test("blank and zero rows are dropped", () => {
  const out = normalizeAllocations(
    [
      { invoiceNo: 1, amount: 100 },
      { invoiceNo: 0, amount: 100 },
      { invoiceNo: 2, amount: 0 },
      { invoiceNo: 3, amount: 0.001 },
    ],
    threeBills()
  );
  assert.deepEqual(out.map((a) => a.invoiceNo), [1]);
});

test("a number that is two different bills is matched on its full key", () => {
  // The defensive half of matching by number. `openBillsFor` only ever hands
  // over one type, but if it ever handed over both, picking either bill for
  // "invoice 1" would settle the wrong one.
  const mixed = [
    { invoiceNo: 1, invoiceType: "Sale", date: new Date("2026-01-01"), balanceDue: 1000, outstanding: 1000, allocated: 0, ageDays: 10 },
    { invoiceNo: 1, invoiceType: "Purchase", date: new Date("2026-02-01"), balanceDue: 500, outstanding: 500, allocated: 0, ageDays: 5 },
  ];

  const named = normalizeAllocations([{ invoiceNo: 1, invoiceType: "Purchase", amount: 100 }], mixed);
  assert.equal(named[0].invoiceType, "Purchase");
  assert.equal(new Date(named[0].invoiceDate).getTime(), new Date("2026-02-01").getTime());

  // And one that names neither is left as it came, for allocationProblems to
  // refuse -- guessing would be worse than refusing.
  const unnamed = normalizeAllocations([{ invoiceNo: 1, amount: 100 }], mixed);
  assert.equal(
    allocationProblems({
      line: { credit: 100 },
      allocations: unnamed,
      bills: mixed,
    }).length,
    1,
    "an ambiguous bill with no type named has to be refused, not guessed"
  );
});

test("amounts are rounded to paise", () => {
  const out = normalizeAllocations([{ invoiceNo: 1, amount: 100.005 }], threeBills());
  assert.equal(out[0].amount, 100.01);
});

console.log("\n--- summing what has been settled ---");

test("allocations from many vouchers sum by bill", () => {
  const settled = allocatedByBill([
    { allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 1000 }] },
    { allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 500 }, { invoiceNo: 2, invoiceType: "Sale", amount: 300 }] },
  ]);
  assert.equal(settled.get("Sale#1"), 1500);
  assert.equal(settled.get("Sale#2"), 300);
});

test("a sale and a purchase of the same number do not merge", () => {
  const settled = allocatedByBill([
    { allocations: [{ invoiceNo: 7, invoiceType: "Sale", amount: 100 }] },
    { allocations: [{ invoiceNo: 7, invoiceType: "Purchase", amount: 200 }] },
  ]);
  assert.equal(settled.get("Sale#7"), 100);
  assert.equal(settled.get("Purchase#7"), 200);
});

test("a line with no allocations contributes nothing", () => {
  assert.equal(allocatedByBill([{ name: "Acme" }, {}]).size, 0);
  assert.equal(allocatedByBill([]).size, 0);
});

test("the summed figure feeds straight back into the outstanding", () => {
  // The whole reason there is no OUTBILL table: outstanding is derived from
  // the allocations, which live on the vouchers that made them.
  const settled = allocatedByBill([
    { allocations: [{ invoiceNo: 1, invoiceType: "Sale", amount: 1500 }] },
  ]);
  const list = threeBills(settled);
  assert.equal(bill(list, 1).outstanding, 3500);
});

console.log("\n--- the strip above the picker ---");

test("the summary describes what is on screen", () => {
  const bills = threeBills();
  const allocations = fifoAllocate({ credit: 6000 }, bills);
  const s = adjustmentSummary({ credit: 6000 }, allocations, bills);
  assert.equal(s.amount, 6000);
  assert.equal(s.allocated, 6000);
  assert.equal(s.onAccount, 0);
  assert.equal(s.bills, 3);
  assert.equal(s.billsTouched, 2);
  assert.equal(s.outstandingTotal, 10000);
  assert.equal(s.fullyAllocated, true);
});

test("a part-allocated receipt reports the remainder", () => {
  const bills = threeBills();
  const s = adjustmentSummary({ credit: 8000 }, [{ invoiceNo: 1, invoiceType: "Sale", amount: 5000 }], bills);
  assert.equal(s.allocated, 5000);
  assert.equal(s.onAccount, 3000);
  assert.equal(s.fullyAllocated, false);
});

console.log("\n--- why the list is empty ---");

test("a list with bills in it has no reason to explain", () => {
  assert.equal(emptyReason({ party: "Acme", type: "Sale", bills: threeBills() }), null);
});

test("unpaid bills on the other side name the other column", () => {
  // THE COMMONEST MISTAKE, and the one Sigfa's "No Pending Bills Found"
  // hides: a receipt typed into Debit asks for PURCHASE bills, correctly
  // finds none, and says nothing about the five sale bills sitting unpaid.
  const r = emptyReason({
    party: "Acme Traders",
    type: "Purchase",
    bills: [],
    counts: { anyOfType: 0, opposite: 5 },
  });
  assert.match(r, /Acme Traders/);
  assert.match(r, /5 unpaid sale bills/);
  assert.match(r, /Credit/, "it has to name the column to move the amount to");

  // And the other way round, naming the other column.
  const flip = emptyReason({
    party: "Acme Traders",
    type: "Sale",
    bills: [],
    counts: { anyOfType: 0, opposite: 2 },
  });
  assert.match(flip, /2 unpaid purchase bills/);
  assert.match(flip, /Debit/);
});

test("one bill on the other side is singular", () => {
  const r = emptyReason({
    party: "Acme",
    type: "Sale",
    bills: [],
    counts: { anyOfType: 0, opposite: 1 },
  });
  assert.match(r, /1 unpaid purchase bill\b/);
  assert.doesNotMatch(r, /1 unpaid purchase bills/);
});

test("all settled says so, and says the money stays on account", () => {
  const r = emptyReason({
    party: "Acme",
    type: "Sale",
    bills: [],
    counts: { anyOfType: 4, opposite: 0 },
  });
  assert.match(r, /All 4/);
  assert.match(r, /settled/);
  assert.match(r, /on account/);
});

test("a party with no bills at all is not told they are settled", () => {
  const r = emptyReason({ party: "Acme", type: "Sale", bills: [], counts: {} });
  assert.match(r, /no sale bills/);
  assert.doesNotMatch(r, /settled/, "nothing was settled -- there was nothing");
});

test("the wrong-column hint wins over the settled one", () => {
  // Both are true when every sale bill is paid and a purchase bill is not.
  // The actionable one is the column.
  const r = emptyReason({
    party: "Acme",
    type: "Sale",
    bills: [],
    counts: { anyOfType: 3, opposite: 2 },
  });
  assert.match(r, /Debit/);
});

test("a party with no name still reads as a sentence", () => {
  assert.match(emptyReason({ type: "Sale", bills: [], counts: {} }), /^This party has no sale bills/);
});

console.log("\n--- wiring ---");

test("allocations are declared on the voucher line", () => {
  // Mongoose strict mode silently DROPS undeclared subdocument fields. This
  // project has lost an afternoon to that seven times.
  const src = read("../models/voucherModel.js");
  assert.ok(/allocations:\s*\[/.test(src));
  for (const field of ["invoiceNo", "invoiceType", "invoiceDate", "amount"]) {
    assert.ok(new RegExp(`${field}:\\s*\\{`).test(src), `${field} is not declared`);
  }
});

test("the allocation lookup has an index", () => {
  // Asked every time the picker opens and again on every save.
  assert.ok(/customers\.allocations\.invoiceNo/.test(read("../models/voucherModel.js")));
});

test("both voucher routes validate, and only the editor excludes itself", () => {
  // Without the exclusion, re-saving a voucher without touching its
  // adjustment refuses itself -- the same mistake findNameClash's excludeId
  // was added for.
  const add = read("../app/api/voucher-add/route.js");
  const alter = read("../app/api/voucher-alter/route.js");
  assert.ok(/validateAllocations/.test(add));
  assert.ok(/validateAllocations/.test(alter));
  assert.ok(/excludeVoucherId: id/.test(alter));
  assert.equal(/excludeVoucherId/.test(add), false, "a new voucher has nothing to exclude");
});

test("validation happens inside the transaction", () => {
  // Checked outside, two people could settle the same bill at once -- each
  // allowed by a snapshot taken before the other committed.
  for (const route of ["../app/api/voucher-add/route.js", "../app/api/voucher-alter/route.js"]) {
    const src = read(route);
    assert.ok(/session,?\s*\}\)/.test(src.slice(src.indexOf("validateAllocations"))), `${route} does not pass the session`);
  }
});

test("the routes store the CLEANED lines, not the request's", () => {
  // Otherwise the type a client named is what gets saved.
  assert.ok(/customers: lines/.test(read("../app/api/voucher-add/route.js")));
  assert.ok(/customers: lines/.test(read("../app/api/voucher-alter/route.js")));
});

test("the picker and the save use one definition of outstanding", () => {
  // Three implementations of "what is left on this bill" is three chances for
  // the screen to offer something the save then refuses.
  for (const f of ["../app/api/open-bills/route.js", "../lib/openBillsFor.mjs"]) {
    assert.ok(/openBillsFor|openBills/.test(read(f)), `${f} rolls its own`);
  }
  assert.ok(/from "\.\/billAdjust\.mjs"/.test(read("../lib/openBillsFor.mjs")));
});

test("the open-bills route refuses a request with no direction", () => {
  // Which bills are eligible depends on which way the money is going, and
  // guessing offers bills the firm owes against money it received.
  const src = read("../app/api/open-bills/route.js");
  assert.ok(/type !== "Sale" && type !== "Purchase"/.test(src));
});

test("the rules module stays free of Mongoose", () => {
  const src = read("../lib/billAdjust.mjs");
  assert.equal(/from ["']mongoose["']/.test(src), false);
  assert.equal(/\.\.\/models\//.test(src), false);
});

test("the picker is behind the voucher permission", () => {
  assert.equal(permissionForPath("/api/open-bills"), "voucher:write");
  assert.equal(canAccessPath("accountant", "/api/open-bills"), true);
  // A biller who cannot raise a voucher has no reason to be shown the
  // outstanding ledger behind one.
  assert.equal(canAccessPath("biller", "/api/open-bills"), false);
});

test("the form clears an adjustment when the party or direction changes", () => {
  // Kept, it would be saved against invoices this party never raised -- and
  // the server would refuse the whole voucher rather than that one line.
  const src = read("../app/voucheradd/page.js");
  assert.ok(/allocations: \[\],/.test(src));
  assert.ok(/billTypeFor\(next\) !== billTypeFor\(entry\)/.test(src));
});

test("the form loads an existing voucher's adjustments", () => {
  // Without this, reopening a voucher and saving it drops its adjustment.
  assert.ok(/allocations: custEntry\.allocations/.test(read("../app/voucheradd/page.js")));
});

test("the form sends them, and shows the server's refusal", () => {
  const src = read("../app/voucheradd/page.js");
  assert.ok(/allocations: entry\.allocations/.test(src));
  // "Failed to save voucher" tells the user nothing they can act on; the
  // server names the bill and the figure. Read through lib/apiResponse.mjs,
  // which takes the route's `error` (or `message`) and shows it as-is.
  assert.ok(/const \{ ok, message \} = await readResponse\(res\)/.test(src));
  assert.ok(/The voucher was not saved\. \$\{message\}/.test(src));
});

test("ticking the box changes something the user can see", () => {
  // THE BUG THIS FEATURE SHIPPED WITH. The tick lived below the entry table
  // with the account fields, so ticking it altered a column off-screen
  // ABOVE, and the only visible effect was a greyed-out button nobody had
  // scrolled back up to. It read as doing nothing at all.
  const src = read("../app/voucheradd/page.js");
  const tick = src.indexOf('name="againstBill"');
  const table = src.indexOf("<table");
  assert.ok(tick > 0 && table > 0);
  assert.ok(tick < table, "the tick has to come before the lines it governs");

  // And every line says what it is waiting for, rather than greying out.
  assert.ok(/Pick a party/.test(src));
  assert.ok(/Enter a debit or a credit/.test(src));
  assert.ok(/Nothing adjusted yet/.test(src));
});

test("the bills come up as focus leaves a finished line", () => {
  // Sigfa brings the grid up on leaving the line. Waiting for a button to be
  // noticed is what made the feature look broken.
  const src = read("../app/voucheradd/page.js");
  assert.ok(/const leaveLine = /.test(src));
  assert.equal(
    (src.match(/onBlur=\{leaveLine\(index\)\}/g) || []).length,
    2,
    "both the debit and the credit box have to trigger it"
  );
  // Tabbing from Debit to Credit is not leaving the line.
  assert.ok(/relatedTarget/.test(src) && /closest\("tr"\)/.test(src));
  // Offered once, or closing it would be a trap.
  assert.ok(/offered\.current\.has\(index\)/.test(src));
  assert.ok(/offered\.current\.add\(index\)/.test(src));
  assert.ok(/offered\.current\.delete\(index\)/.test(src), "a new party is a new adjustment");
});

test("an empty picker says which of the three things happened", () => {
  const route = read("../app/api/open-bills/route.js");
  assert.ok(/emptyReason/.test(route));
  // The counts cost two queries, so they are only asked for when there is
  // nothing to show.
  assert.ok(/bills\.length \? null : await billCountsFor/.test(route));
  assert.ok(/reason/.test(read("../components/BillAdjust.jsx")));
});

test("the counts read the same collection the bills came from", () => {
  // A count taken from somewhere else could contradict the list beside it.
  const src = read("../lib/openBillsFor.mjs");
  const counts = src.slice(src.indexOf("billCountsFor"));
  assert.ok(/Invoice\.countDocuments/.test(counts));
  assert.ok(/"customer\.name": name/.test(counts));
  assert.ok(/return: \{ \$ne: true \}/.test(counts), "a credit note is not a bill to chase");
  assert.ok(/OPPOSITE_TYPE/.test(src), "the other side is not hardcoded twice");
});

test("the picker does its own checking from the same module", () => {
  // So the screen says why before the save does, not instead of it.
  const src = read("../components/BillAdjust.jsx");
  assert.ok(/allocationProblems/.test(src));
  assert.ok(/from '@\/lib\/billAdjust\.mjs'/.test(src));
  assert.ok(/billTypeFor/.test(src), "and does not decide the direction itself");
});

console.log(`\n${passed} checks passed`);
