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
import { kindOf, postsAccount } from "./voucherKinds.mjs";

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

/**
 * What the ACCOUNT row shows in its own contra column.
 *
 * For a receipt, a payment or a contra that is the instrument -- "Cash",
 * "Bank" -- which is what the cash book reads. A credit or debit note has no
 * instrument, so the useful answer is the party the note was raised against,
 * and the kind's name when there is more than one party to choose from.
 * Naming one of several arbitrarily is how a ledger comes to assert
 * something nobody entered.
 */
export const accountContra = (spec, customers = [], paymentType) =>
  spec.needsPaymentType
    ? paymentType
    : customers.length === 1
      ? text(customers[0]?.name) || spec.label
      : spec.label;

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
  // A note saved with a "Booked to" head still books against it; one saved
  // since that box went has none. lib/voucherKinds.mjs, postsAccount.
  const hasAccount = postsAccount(spec, acName);

  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;

  customers.forEach((line, index) => {
    const debit = round2(line.debit);
    const credit = round2(line.credit);

    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);

    const contra = hasAccount ? acName : journalContra(customers, index);

    rows.push({
      customerName: line.name,
      date,
      account: contra,
      // Carried as text and never branched on, so naming the kind here is
      // information in the cash book's own column rather than a flag. Only
      // the three kinds that move money through an instrument have a real
      // one; a journal and the two notes say what they are instead.
      paymentType: spec.needsPaymentType ? paymentType : spec.label,
      // Copied onto the row so the day book can say which kind wrote it --
      // it reads rows and never opens the voucher. models/ledgerModel.js.
      voucherKind: spec.code,
      debit,
      credit,
      narration: line.narration || `Against ${contra}`,
      voucherId,
    });
  });

  /*
    The account absorbing the opposite of the lines, booked on the other
    side. A journal has none -- and inventing one would post a cash entry
    for an adjustment that never touched cash.

    For a receipt, a payment or a contra this is the cash or bank account
    the money moved through. For a credit or debit note it is the head the
    adjustment was booked to -- Discount Allowed, Rejected Material -- which
    moves exactly the same way and simply is not an instrument. That is the
    whole reason `needsAccount` and `needsPaymentType` are two flags.
  */
  if (hasAccount) {
    /*
      The NET of the lines, on ONE side.

      This was `debit: totalCredit, credit: totalDebit` while every kind with
      an account was locked to a single column: one of those two totals was
      always zero, so only one side of the row was ever filled and the net
      and the pair were the same thing.

      The two notes are free-sided now (lib/voucherKinds.mjs), so both totals
      can be non-zero at once -- a note debiting one party and crediting
      another -- and that expression would have put 500 in BOTH columns of a
      single row. Every figure downstream nets it back to the same number, so
      no balance was ever at risk; what was at risk is a person reading the
      ledger, because a row carrying a debit AND a credit of its own is not
      an entry anybody can read, and it is not what the account absorbed. It
      absorbed the difference.

      Byte-identical for RECEIPT, PAYMENT and CONTRA, which is pinned by a
      test rather than left as a claim.
    */
    const net = round2(totalCredit - totalDebit);

    rows.push({
      customerName: acName,
      date,
      account: accountContra(spec, customers, paymentType),
      paymentType: spec.needsPaymentType ? paymentType : spec.label,
      voucherKind: spec.code,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
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

  if (postsAccount(spec, acName)) {
    deltas.push({ name: acName, delta: round2(-total) });
  }

  return deltas;
}
