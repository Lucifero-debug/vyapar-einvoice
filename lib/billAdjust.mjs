/**
 * Settling a receipt or payment against particular bills.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/bill-adjust.test.mjs directly. Never import Mongoose in here.
 *
 *
 * WHERE THIS CAME FROM
 * --------------------
 * Sigfa's "Against Bill" tick on a voucher, and the ledger behind it:
 *
 *   OUTBILL    one row per unpaid bill -- party, date, DUEDATE, BLAMT, AdjAmt
 *   OUTBILL1   the allocations: which voucher settled which bill, for how much
 *   JOURNAL    AgMkey / AgDocno / AgRefno / AdjAmt, the link on the voucher
 *
 * The rules are its own, visible in its strings: "Adjustment on FIFO Basis",
 * "Adjusted Amount Exceeds Amount to be Adjusted", "Bal. Amount Can't Be Less
 * Than Adjusted Amt", "No Pending Bills Found", "Payment Already Adjusted",
 * and both directions -- "Payment Received - Bill Adjustment" and "Payment
 * Paid - Bill Adjustment".
 *
 * Its own client has 1 row in OUTBILL and 0 in OUTBILL1, so they never use it.
 * The behaviour is still well enough defined to copy, including the part that
 * matters most: Sigfa lets you adjust PART of a receipt and leave the rest on
 * account. A tick that demanded every rupee be allocated would make the
 * feature unusable the first time somebody paid a round figure.
 *
 *
 * ONE DEPARTURE, AND IT REMOVES A WHOLE CLASS OF BUG
 * -------------------------------------------------
 * There is no OUTBILL here. What is outstanding on a bill is DERIVED:
 *
 *     outstanding = balanceDue - everything allocated to it
 *
 * Sigfa keeps a table and has to repair it -- its own strings include "It Will
 * Delete All Bill Adjustment And Re-Build OUTBILL" and "DUE TO NOT PROPER BILL
 * ADJUSTMENT...", which is what a stored figure drifting looks like from the
 * inside.
 *
 * Deriving is cheap because of where the allocation lives: on the VOUCHER
 * LINE itself. Deleting a voucher removes its allocations with it, in the
 * same write, so there is no counter to reverse and nothing that can be
 * reversed wrongly. That is the opposite of the order module, where
 * `invoicedQty` sits on the order while the claim is made by an invoice in
 * another collection -- which is exactly why that one needs
 * lib/orderClaims.mjs and a reconciliation report, and this one does not.
 */

import { round2 } from "./balance.mjs";
import { istDayNumber } from "./istDate.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** A rupee is settled to the paisa; below that is not a debt. */
export const MONEY_EPSILON = 0.005;

/**
 * Which bills a voucher line settles.
 *
 * Balances are signed, positive Dr (lib/balance.mjs): a sale debits the
 * party, so money coming BACK from them is a credit, and that credit settles
 * SALE invoices. Money paid out is a debit on the party and settles PURCHASE
 * invoices.
 *
 * Returns null for a line that is neither, or both -- there is nothing to
 * settle against and no honest guess to make.
 */
export const billTypeFor = (line) => {
  const debit = num(line?.debit);
  const credit = num(line?.credit);
  if (credit > 0 && debit <= 0) return "Sale";
  if (debit > 0 && credit <= 0) return "Purchase";
  return null;
};

/** The amount this line has to allocate. */
export const lineAmount = (line) => round2(Math.abs(num(line?.debit) - num(line?.credit)));

/**
 * What is still owed on one bill.
 *
 *   balanceDue        what was left when the invoice was raised
 *   allocated         everything settled against it since, by any voucher
 *
 * `balanceDue` is used rather than `finalAmount` because money taken at the
 * counter is already accounted for by the invoice's own receipt leg
 * (lib/invoicePosting.mjs). Starting from the full value would ask the party
 * to pay the counter payment twice.
 */
export const outstandingOf = (invoice, allocated = 0) =>
  round2(num(invoice?.balanceDue) - num(allocated));

/**
 * The bills a party still owes, oldest first.
 *
 * `allocatedByInvoice` maps an invoice key (see `billKey`) to how much has
 * been settled against it.
 *
 * RETURNS ARE EXCLUDED. A sale return is a credit note, and allocating one
 * against a bill is a different operation -- Sigfa calls it "Cross
 * Adjustment" and gives it its own screen. Including them here with a
 * negative outstanding would let a receipt be allocated to a negative bill,
 * which reads as settling a debt by taking more money.
 *
 * Oldest first because that is the order FIFO settles in, and because a
 * chase list that is not in age order is not a chase list.
 */
export const openBills = ({
  invoices = [],
  allocatedByInvoice = new Map(),
  type,
  now = Date.now(),
} = {}) => {
  const wanted = text(type);

  return invoices
    .filter((inv) => inv && !inv.return)
    .filter((inv) => (wanted ? text(inv.type) === wanted : true))
    .map((inv) => {
      const allocated = num(allocatedByInvoice.get?.(billKey(inv)) ?? allocatedByInvoice[billKey(inv)]);
      const outstanding = outstandingOf(inv, allocated);
      return {
        invoiceNo: num(inv.invoiceNo),
        invoiceType: text(inv.type),
        date: inv.date || null,
        total: round2(num(inv.finalAmount)),
        received: round2(num(inv.received)),
        balanceDue: round2(num(inv.balanceDue)),
        allocated: round2(allocated),
        outstanding,
        ageDays: ageInDays(inv.date, now),
        party: text(inv.customer?.name),
      };
    })
    // Only what is still owed. A bill settled to the paisa is not pending,
    // and a list that kept showing it would grow forever.
    .filter((bill) => bill.outstanding > MONEY_EPSILON)
    .sort((a, b) => b.ageDays - a.ageDays || a.invoiceNo - b.invoiceNo);
};

/**
 * How old a bill is, in whole days.
 *
 * Compared as IST calendar days -- the server's day is not the shopkeeper's,
 * and this container runs on Asia/Calcutta while Vercel runs UTC. The note in
 * lib/accountBooks.mjs has the measurement.
 */
export const ageInDays = (date, now = Date.now()) => {
  const then = istDayNumber(date);
  const today = istDayNumber(now);
  if (then === null || today === null) return 0;
  return Math.max(0, Math.round((dayToMs(today) - dayToMs(then)) / 86400000));
};

const dayToMs = (dayNumber) =>
  Date.UTC(Math.floor(dayNumber / 10000), (Math.floor(dayNumber / 100) % 100) - 1, dayNumber % 100);

/** The key an allocation names a bill by. Type AND number: sale 7 and purchase 7 are different bills. */
export const billKey = (billOrAllocation) =>
  `${text(billOrAllocation?.invoiceType ?? billOrAllocation?.type)}#${num(
    billOrAllocation?.invoiceNo
  )}`;

/** Everything a set of allocations adds up to. */
export const allocatedTotal = (allocations = []) =>
  round2(allocations.reduce((total, a) => round2(total + num(a?.amount)), 0));

/**
 * What is left over after allocating -- Sigfa's on-account balance.
 *
 * Never negative: over-allocating is refused by `allocationProblems`, so a
 * negative here would be a figure nobody should be shown.
 */
export const onAccount = (line, allocations = []) =>
  Math.max(0, round2(lineAmount(line) - allocatedTotal(allocations)));

/**
 * What is wrong with this allocation, in words. [] when it can be saved.
 *
 * Sigfa's own three refusals, in its own order, plus the two that fall out of
 * having a typed key.
 */
export const allocationProblems = ({ line, allocations = [], bills = [] } = {}) => {
  const problems = [];
  const amount = lineAmount(line);

  if (!allocations.length) return problems;

  if (amount <= MONEY_EPSILON) {
    problems.push("This line has no amount to adjust.");
    return problems;
  }

  const byKey = new Map(bills.map((b) => [billKey(b), b]));
  const seen = new Set();

  for (const allocation of allocations) {
    const key = billKey(allocation);
    const value = round2(num(allocation?.amount));
    const bill = byKey.get(key);

    if (!bill) {
      problems.push(`${key.replace("#", " invoice ")} is not an open bill for this party.`);
      continue;
    }
    if (value <= 0) {
      problems.push(`Adjusted amount against invoice ${bill.invoiceNo} must be more than zero.`);
      continue;
    }
    // Sigfa: "Bal. Amount Can't Be Less Than Adjusted Amt i.e."
    //
    // THE DIFFERENCE is compared against the tolerance, not the amount
    // against a rounded bound. `round2(outstanding + MONEY_EPSILON)` -- what
    // this said first -- lands wherever the binary representation of that sum
    // happens to fall: on 5000 it rounds back to 5000, so the tolerance
    // vanishes and the direction of the sign cannot be told apart; on 1234.56
    // it rounds up to 1234.57, so a whole paisa MORE than the bill owes slips
    // through. Subtracting first gives the same answer for every amount.
    if (value - bill.outstanding > MONEY_EPSILON) {
      problems.push(
        `Invoice ${bill.invoiceNo} has only ${bill.outstanding.toFixed(2)} outstanding -- ${value.toFixed(2)} cannot be adjusted against it.`
      );
    }
    // One bill, one line, one allocation. Two rows for the same bill are a
    // mistake, and summing them silently would let the pair exceed the bill
    // while each passed the check above.
    if (seen.has(key)) {
      problems.push(`Invoice ${bill.invoiceNo} appears twice in this adjustment.`);
    }
    seen.add(key);
  }

  // Sigfa: "Adjusted Amount Exceeds Amount to be Adjusted"
  const total = allocatedTotal(allocations);
  if (total - amount > MONEY_EPSILON) {
    problems.push(
      `Adjusted ${total.toFixed(2)} exceeds the ${amount.toFixed(2)} on this line.`
    );
  }

  return problems;
};

/**
 * Sigfa's "Adjustment on FIFO Basis": fill the oldest bills first.
 *
 * Returns the allocations it would make. It allocates what it can and stops;
 * whatever is left over stays on account, which is what Sigfa does and what
 * anybody expects from a round-figure payment.
 */
export const fifoAllocate = (line, bills = []) => {
  let left = lineAmount(line);
  const out = [];

  // `openBills` already returns oldest first, but FIFO must not depend on the
  // caller having sorted -- it is the whole meaning of the word.
  const ordered = [...bills].sort((a, b) => b.ageDays - a.ageDays || a.invoiceNo - b.invoiceNo);

  for (const bill of ordered) {
    // An early exit, not a rule: `left` is always a 2-decimal value, so this
    // is only true at exactly 0, and there `take` rounds to 0 and the
    // `continue` below would skip the bill regardless.
    if (left <= MONEY_EPSILON) break;
    const take = round2(Math.min(left, bill.outstanding));
    if (take <= MONEY_EPSILON) continue;
    out.push({
      invoiceNo: bill.invoiceNo,
      invoiceType: bill.invoiceType,
      invoiceDate: bill.date || null,
      amount: take,
    });
    left = round2(left - take);
  }

  return out;
};

/** Clean what the form sent into what the voucher stores. */
export const normalizeAllocations = (allocations = [], bills = []) => {
  // THE BILL IS FOUND BY NUMBER, and its type and date are then copied from
  // it. Looking it up by the typed key -- the obvious thing, and what this
  // did first -- defeats the whole point: a request naming the wrong type
  // simply finds no bill, and the fallback keeps the type the request sent.
  // The lie survives exactly the check meant to catch it.
  //
  // The list is one party's bills of ONE type, because `openBillsFor` derives
  // that type from the line's own direction rather than taking it from the
  // caller. A number appearing twice would mean it is not, so those fall back
  // to the full typed key and `allocationProblems` refuses what still fails
  // to match. Silently picking one of two same-numbered bills would settle
  // the wrong one.
  const byNumber = new Map();
  const ambiguous = new Set();
  for (const bill of bills) {
    const no = num(bill?.invoiceNo);
    if (byNumber.has(no)) ambiguous.add(no);
    else byNumber.set(no, bill);
  }
  const byKey = new Map(bills.map((b) => [billKey(b), b]));

  return allocations
    .map((a) => {
      const no = num(a?.invoiceNo);
      const bill = ambiguous.has(no) ? byKey.get(billKey(a)) : byNumber.get(no);
      return {
        invoiceNo: no,
        invoiceType: bill ? bill.invoiceType : text(a?.invoiceType),
        // The date is the bill's, kept so a printed adjustment goes on saying
        // what it said even after the invoice is altered.
        invoiceDate: bill?.date ?? a?.invoiceDate ?? null,
        amount: round2(num(a?.amount)),
      };
    })
    .filter((a) => a.invoiceNo > 0 && a.amount > MONEY_EPSILON);
};

/**
 * Everything settled against each bill, from the vouchers that did it.
 *
 * `lines` is every voucher line in the book that carries allocations. Summed
 * by bill key, which is what makes `outstanding` derivable and the whole
 * OUTBILL table unnecessary.
 */
export const allocatedByBill = (lines = []) => {
  const out = new Map();
  for (const line of lines) {
    for (const allocation of line?.allocations || []) {
      const key = billKey(allocation);
      out.set(key, round2((out.get(key) || 0) + num(allocation?.amount)));
    }
  }
  return out;
};

/** The strip above the picker. */
export const adjustmentSummary = (line, allocations = [], bills = []) => {
  const amount = lineAmount(line);
  const allocated = allocatedTotal(allocations);
  return {
    amount,
    allocated,
    onAccount: onAccount(line, allocations),
    bills: bills.length,
    billsTouched: allocations.filter((a) => num(a?.amount) > MONEY_EPSILON).length,
    outstandingTotal: round2(bills.reduce((t, b) => round2(t + num(b.outstanding)), 0)),
    fullyAllocated: Math.abs(round2(amount - allocated)) <= MONEY_EPSILON,
  };
};

/** Sigfa: "No Pending Bills Found". */
export const nothingToAdjust = (bills = []) => bills.length === 0;
