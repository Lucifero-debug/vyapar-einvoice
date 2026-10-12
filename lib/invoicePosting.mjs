/**
 * Single source of truth for everything one invoice posts.
 *
 * Creating and editing an invoice have to produce identical rows and identical
 * balance movements, or the books change shape the first time someone corrects
 * a typo. They did not: `sale-alter` adjusted the party balance and never
 * touched the ledger or the stock ledger at all, so after any edit the ledger
 * report and the customer balance disagreed permanently and stock kept the
 * pre-edit quantities.
 *
 * Both routes now go through here. `voucherLedger.mjs` does the same job for
 * vouchers, for the same reason.
 *
 * AN INVOICE POSTS THREE LEGS
 * ---------------------------
 *   the document   party moves by the FULL invoice value, against Sales /
 *                  Purchase Account
 *   the receipt    anything settled at the counter moves the party back and
 *                  lands on cash
 *   the contra     Sales or Purchase, the GST heads, and the round-off --
 *                  lib/invoiceGl.mjs
 *
 * The first two net to `balanceDue`, which is what the party balance used to
 * move by on its own -- so switching that on never shifted a party balance,
 * it only made the ledger and the cash account tell the truth.
 *
 * The third was missing entirely until the financial statements needed it.
 * "Sales Account" appeared in the contra column of the party's row as TEXT,
 * with no row owned by that account and nothing at all for GST, so a trial
 * balance drawn from this ledger was short by exactly sales plus tax. The
 * note atop lib/invoiceGl.mjs has the full reasoning, including why the
 * difference between `finalAmount` and taxable-plus-tax goes to a round-off
 * head rather than being absorbed into Sales.
 */

import { invoiceDelta, receiptDelta, round2, voucherDelta } from "./balance.mjs";
import { glRows } from "./invoiceGl.mjs";

/** A signed movement, as the debit/credit pair a ledger row stores. */
export const sides = (delta) => ({
  debit: delta > 0 ? Math.abs(delta) : 0,
  credit: delta < 0 ? Math.abs(delta) : 0,
});

/**
 * Every balance movement one invoice causes.
 *
 * `party` is the net of both legs; `cash` is zero when nothing was settled.
 */
export function invoicePostingDeltas({
  type,
  isReturn = false,
  finalAmount = 0,
  received = 0,
}) {
  const doc = invoiceDelta({ type, isReturn, amount: round2(finalAmount) });
  const settled = round2(received);
  const { party: receiptParty, cash } = receiptDelta({
    type,
    isReturn,
    received: settled,
  });

  return {
    docDelta: doc,
    receiptDelta: receiptParty,
    partyDelta: round2(doc + receiptParty),
    cashDelta: cash,
    settled,
  };
}

/**
 * The ledger rows one invoice writes: the document, the two sides of the
 * receipt when something was settled, and the contra side.
 *
 * `invoice` is the saved document, and it is what the contra side is derived
 * from -- its LINES, not its stored totals (lib/invoiceGl.mjs explains why).
 * Omitting it writes the party and receipt rows only, which is a half-entry:
 * it is optional solely so the backfill script can ask for the contra rows on
 * their own, and a wiring test asserts that both billing routes pass it.
 */
export function buildInvoiceLedgerRows({
  type,
  customerName,
  cashAccountName,
  invoiceNo,
  date,
  paymentType,
  voucherId,
  deltas,
  partyBalance = 0,
  cashBalance = 0,
  invoice = null,
}) {
  const rows = [
    {
      customerName,
      date,
      account: type === "Sale" ? "Sales Account" : "Purchase Account",
      paymentType: paymentType || "Credit",
      // Sides follow the signed balance movement, so returns land on the
      // opposite side of the invoice they reverse.
      ...sides(deltas.docDelta),
      balance: partyBalance,
      narration: `By Invoice No: ${invoiceNo}`,
      voucherId,
    },
  ];

  // Both legs of the receipt go in together or neither does: guarding on
  // `> 0` would post the party side of a negative entry with nothing facing it.
  if (deltas.settled !== 0) {
    // Cash coming in is a receipt; cash going out (a purchase, or a refund on
    // a return) is a payment.
    const narration = `${deltas.cashDelta > 0 ? "Receipt" : "Payment"} against Invoice No: ${invoiceNo}`;

    rows.push(
      {
        customerName,
        date,
        account: cashAccountName,
        paymentType: cashAccountName,
        ...sides(deltas.receiptDelta),
        balance: partyBalance,
        narration,
        voucherId,
      },
      {
        customerName: cashAccountName,
        date,
        account: customerName,
        paymentType: cashAccountName,
        ...sides(deltas.cashDelta),
        balance: cashBalance,
        narration,
        voucherId,
      }
    );
  }

  // The contra side. Appended here rather than concatenated by each caller,
  // so a route cannot write half an entry by forgetting.
  if (invoice) {
    rows.push(...glRows({ invoice, invoiceNo, date, voucherId, paymentType }));
  }

  return rows;
}

/**
 * How much each account moves, read off the rows that were actually written.
 *
 * ONE source of truth for the balance updates. The party's own rows sum to
 * `deltas.partyDelta` and the cash row to `deltas.cashDelta` by construction,
 * so this is not a new rule for them -- it is the same rule, derived from the
 * thing that gets stored rather than from a parallel calculation.
 *
 * That matters because `delete-invoice` already reverses by reading the rows
 * back. If posting moved balances a different way from how deleting unmoves
 * them, the two would drift -- which is exactly the bug that was found when
 * deleting reversed by the stored `balanceDue` while posting moved the party
 * by `finalAmount - received`.
 *
 * Accumulated by name, so an invoice billed to the cash account itself -- the
 * same document appearing twice -- nets instead of the second write
 * discarding the first.
 */
export function balanceMovesFromRows(rows = []) {
  const moves = new Map();

  for (const row of rows) {
    const name = String(row?.customerName ?? "").trim();
    if (!name) continue;
    const delta = voucherDelta({ debit: row.debit, credit: row.credit });
    if (!delta) continue;
    moves.set(name, round2((moves.get(name) || 0) + delta));
  }

  // A zero net movement is not a movement. Left in, it would spend a round
  // trip on a findOneAndUpdate that changes nothing.
  for (const [name, delta] of [...moves]) if (delta === 0) moves.delete(name);

  return moves;
}

/**
 * The row-derived moves for every account EXCEPT the party, plus -- for an
 * invoice billed to the cash or bank account itself -- that account's cash leg.
 *
 * `sale-alter` and `delete-invoice` move the party by the derived
 * `partyDelta` (so an invoice whose rows were lost, or were never rewritten by
 * an older edit, still reverses correctly), and every other account by what
 * its rows say. They did that by dropping the party from the row moves --
 * right for an ordinary party, and wrong when the party IS the cash account
 * (allowed on purpose, lib/invoiceInput.mjs): the receipt's cash leg is
 * written under the party's own name, and dropping it left the till holding
 * the money of every deleted or edited bill.
 *
 * The cash leg is recognised by its shape -- a row owned by the party whose
 * contra is the party too, which only a self-settled bill writes -- and its
 * amount is the derived `cashDelta`, NOT the party's row total: an invoice
 * last edited by the old sale-alter has party rows that were never rewritten,
 * and trusting their total would move an ordinary party by the stale gap.
 *
 *   moves      balanceMovesFromRows(rows)
 *   rows       the rows themselves (customerName and account are read)
 *   partyName  the invoice's party
 *   cashDelta  the derived cash movement (invoicePostingDeltas)
 */
export function withPartyCashLeg(moves, rows = [], partyName, cashDelta) {
  const name = String(partyName ?? "").trim();
  const out = new Map(moves);
  out.delete(name);
  const selfSettled = rows.some(
    (r) => String(r?.customerName ?? "").trim() === name && String(r?.account ?? "").trim() === name
  );
  const leg = round2(cashDelta);
  if (selfSettled && leg !== 0) out.set(name, leg);
  return out;
}
