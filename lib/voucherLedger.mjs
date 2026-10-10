/**
 * Single source of truth for the ledger rows a voucher produces.
 *
 * A voucher writes one row per party line plus one aggregate row for the
 * account it was paid from/into (cash, bank, ...). Creating and editing a
 * voucher must produce identical rows, or a ledger silently changes shape the
 * first time someone edits an entry.
 *
 * Row shape
 * ---------
 *   customerName  the party this row belongs to — what the ledger groups on
 *   account       the contra account (acName for a party row, the payment
 *                 method for the main row)
 *   debit/credit  the party's side, exactly as entered
 *
 * Both sides of a voucher are written from one place so `voucher-add` and
 * `voucher-alter` cannot drift apart.
 */

import { round2, voucherDelta } from "./balance.mjs";

export function buildVoucherLedgerRows({
  acName,
  date,
  paymentType,
  narration,
  customers = [],
  voucherId,
}) {
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of customers) {
    const debit = round2(line.debit);
    const credit = round2(line.credit);

    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);

    rows.push({
      customerName: line.name,
      date,
      account: acName,
      paymentType,
      debit,
      credit,
      narration: line.narration || `Against ${acName}`,
      voucherId,
    });
  }

  // The account the money actually moved through, booked on the opposite side.
  rows.push({
    customerName: acName,
    date,
    account: paymentType,
    paymentType,
    debit: totalCredit,
    credit: totalDebit,
    narration: narration || "Main account entry",
    voucherId,
  });

  return rows;
}

/**
 * Every balance movement one voucher causes, parties and account alike.
 *
 * The account the money moved through is a Customer doc like any other (the
 * pickers in /voucheradd choose it from the cash and bank groups), and it gets
 * a ledger row like any other -- but its balance was never moved. Only the
 * parties in `customers[]` were, so a cash account's `lastBal` sat frozen
 * while its ledger filled up.
 *
 * It absorbs the opposite of the parties, exactly as its ledger row does, so
 * a voucher always nets to zero across the accounts it touches.
 *
 * Add applies these; alter and delete negate them. Deriving all three from one
 * function is what stops a reversal disagreeing with what was posted.
 */
export function buildVoucherBalanceDeltas({ acName, customers = [] }) {
  const deltas = [];
  let total = 0;

  for (const line of customers) {
    const delta = voucherDelta({ debit: line.debit, credit: line.credit });
    total = round2(total + delta);
    deltas.push({ name: line.name, delta });
  }

  deltas.push({ name: acName, delta: round2(-total) });

  return deltas;
}
