/**
 * Single source of truth for the ledger rows a voucher produces.
 *
 * A voucher with a cash or bank leg -- a receipt, a payment, a contra --
 * writes one row per line plus one aggregate row for the account the money
 * moved through. A JOURNAL has no such account, so it writes its lines and
 * nothing else; its own lines balance instead (lib/voucherKinds.mjs says why
 * that is a rule rather than a courtesy).
 *
 * Creating, editing and deleting a voucher must produce identical rows and
 * identical deltas, or a ledger silently changes shape the first time someone
 * edits an entry and a balance is left half-reversed the first time someone
 * deletes one.
 *
 * Row shape
 * ---------
 *   customerName  the party this row belongs to — what the ledger groups on
 *   account       the contra account (acName for a party row, the payment
 *                 method for the main row, the other side for a journal)
 *   debit/credit  the party's side, exactly as entered
 *
 * Both sides of a voucher are written from one place so `voucher-add`,
 * `voucher-alter` and `delete-voucher` cannot drift apart.
 */

import { round2 } from "./balance.mjs";
import { voucherDelta } from "./balance.mjs";
import { kindOf } from "./voucherKinds.mjs";

const text = (value) => String(value ?? "").trim();

/**
 * What a journal line shows in the ledger's contra column.
 *
 * With exactly two lines it is the other side, which is what makes a journal
 * readable in a party's ledger: "Depreciation" against "Plant & Machinery".
 * With more, there is no single other side and saying so is better than
 * naming one of several arbitrarily.
 */
export const journalContra = (lines = [], index = 0) =>
  lines.length === 2 ? text(lines[1 - index]?.name) || "Journal" : "Journal";

export function buildVoucherLedgerRows({
  kind,
  acName,
  date,
  paymentType,
  narration,
  customers = [],
  voucherId,
}) {
  // An entry saved before kinds existed has none, and `kindOf` reads it off
  // the figures as a receipt or a payment -- both of which carry an account,
  // so the rows below come out exactly as they always did.
  const spec = kindOf({ kind, customers });

  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;

  customers.forEach((line, index) => {
    const debit = round2(line.debit);
    const credit = round2(line.credit);

    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);

    const contra = spec.needsAccount ? acName : journalContra(customers, index);

    rows.push({
      customerName: line.name,
      date,
      account: contra,
      // Carried as text and never branched on, so naming the journal here is
      // information in the cash book's own column rather than a flag.
      paymentType: spec.needsAccount ? paymentType : spec.label,
      // Copied onto the row so the day book can say which kind wrote it --
      // it reads rows and never opens the voucher. models/ledgerModel.js.
      voucherKind: spec.code,
      debit,
      credit,
      narration: line.narration || `Against ${contra}`,
      voucherId,
    });
  });

  // The account the money actually moved through, booked on the opposite
  // side. A journal moved no money, so it has none -- and inventing one
  // would post a cash entry for an adjustment that never touched cash.
  if (spec.needsAccount) {
    rows.push({
      customerName: acName,
      date,
      account: paymentType,
      paymentType,
      voucherKind: spec.code,
      debit: totalCredit,
      credit: totalDebit,
      narration: narration || "Main account entry",
      voucherId,
    });
  }

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
 * A JOURNAL has no such account and needs none: its lines total Dr = Cr, so
 * they already net to zero between themselves. Appending an aggregate for an
 * absent `acName` is how a delete comes to look for an account called
 * "undefined" and leaves the real lines un-reversed -- which is why `kind`
 * has to reach this function from every caller, the reversals included.
 *
 * Add applies these; alter and delete negate them. Deriving all three from one
 * function is what stops a reversal disagreeing with what was posted.
 */
export function buildVoucherBalanceDeltas({ kind, acName, customers = [] }) {
  const spec = kindOf({ kind, customers });

  const deltas = [];
  let total = 0;

  for (const line of customers) {
    const delta = voucherDelta({ debit: line.debit, credit: line.credit });
    total = round2(total + delta);
    deltas.push({ name: line.name, delta });
  }

  if (spec.needsAccount) {
    deltas.push({ name: acName, delta: round2(-total) });
  }

  return deltas;
}
