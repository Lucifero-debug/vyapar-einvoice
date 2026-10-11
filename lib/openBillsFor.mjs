/**
 * Reading a party's open bills out of the database.
 *
 * NOT pure, and one of the documented exceptions in lib/ -- the same as
 * itemLedger.mjs, runningBalances.mjs, cashAccount.mjs, orderClaims.mjs,
 * bomSave.mjs and glAccounts.mjs. The rules live in lib/billAdjust.mjs, which
 * stays runnable under bare node.
 *
 * It exists so the picker, `voucher-add` and `voucher-alter` all compute the
 * outstanding figure the same way. They had every reason not to: the picker
 * reads it to offer bills, and the two write routes read it again to check
 * what was chosen is still available. Three implementations of "what is left
 * on this bill" is three chances for the screen to offer something the save
 * then refuses.
 *
 * `excludeVoucherId` is the part that is easy to leave out. When an existing
 * voucher is being edited, its OWN allocations must not count against the
 * bills it is allocating to -- otherwise re-saving a voucher without touching
 * it refuses itself, exactly as re-saving a customer collided with its own
 * name before `findNameClash` took an `excludeId`.
 */

import Invoice from "../models/invoiceModel";
import Voucher from "../models/voucherModel";
import {
  allocatedByBill,
  allocationProblems,
  billTypeFor,
  normalizeAllocations,
  openBills,
} from "./billAdjust.mjs";

const text = (value) => String(value ?? "").trim();

/**
 * One party's open bills of one type, with what is already settled netted off.
 *
 *   party               the account name, as the ledger joins on it
 *   type                'Sale' or 'Purchase'
 *   excludeVoucherId    the voucher being edited, left out of the totals
 */
export async function openBillsFor({ party, type, excludeVoucherId, session, now } = {}) {
  const name = text(party);
  if (!name || !text(type)) return [];

  const opts = session ? { session } : {};

  const [invoices, vouchers] = await Promise.all([
    Invoice.find(
      {
        "customer.name": name,
        type: text(type),
        return: { $ne: true },
        // Only bills with something left on them. The rules module filters
        // again on the derived figure, but asking the database first keeps a
        // party with years of settled invoices from being loaded in full.
        balanceDue: { $gt: 0 },
      },
      { invoiceNo: 1, type: 1, date: 1, finalAmount: 1, received: 1, balanceDue: 1, customer: 1, return: 1 },
      opts
    ).lean(),

    // Every voucher that has settled something for this party. Narrowed on
    // the party AND on an allocation existing, so a book of plain receipts
    // costs nothing here.
    Voucher.find(
      {
        "customers.name": name,
        "customers.allocations.0": { $exists: true },
        ...(excludeVoucherId ? { _id: { $ne: excludeVoucherId } } : {}),
      },
      { customers: 1 },
      opts
    ).lean(),
  ]);

  // Only this party's lines. A voucher holds several parties, and counting
  // another party's allocations against these bills would hide money that is
  // still owed.
  const lines = [];
  for (const voucher of vouchers) {
    for (const line of voucher.customers || []) {
      if (text(line?.name) === name) lines.push(line);
    }
  }

  return openBills({
    invoices,
    allocatedByInvoice: allocatedByBill(lines),
    type: text(type),
    now: now ?? Date.now(),
  });
}

/**
 * Check and clean what the form sent, against the bills as they stand NOW.
 *
 * Inside the caller's transaction, so the outstanding figure it checks
 * against is the one that will be true when the write lands. Checking outside
 * would let two people settle the same bill twice -- each allowed by a
 * snapshot taken before the other committed.
 *
 * Returns `{ customers, problems }`. `customers` is the lines with their
 * allocations normalised; `problems` is empty when it can be saved.
 *
 * A line with no allocations passes straight through: `againstBill` is a
 * tick, not a requirement, and Sigfa lets a receipt be adjusted in part and
 * left on account for the rest.
 */
export async function validateAllocations({
  customers = [],
  excludeVoucherId,
  session,
  now,
} = {}) {
  const problems = [];
  const out = [];

  for (const line of customers) {
    const allocations = line?.allocations || [];
    if (!allocations.length) {
      // Nothing to check, and nothing to store. An empty array is stripped
      // rather than saved, so a line that was adjusted and then cleared does
      // not keep an empty husk.
      const { allocations: _drop, ...rest } = line || {};
      out.push(rest);
      continue;
    }

    const type = billTypeFor(line);
    if (!type) {
      problems.push(
        `${text(line?.name) || "A line"} has no amount, or has both a debit and a credit, so there is nothing to adjust against a bill.`
      );
      out.push(line);
      continue;
    }

    const bills = await openBillsFor({
      party: line.name,
      type,
      excludeVoucherId,
      session,
      now,
    });

    const cleaned = normalizeAllocations(allocations, bills);
    const found = allocationProblems({ line, allocations: cleaned, bills });
    for (const problem of found) problems.push(`${text(line.name)}: ${problem}`);

    out.push({ ...line, allocations: cleaned });
  }

  return { customers: out, problems };
}
