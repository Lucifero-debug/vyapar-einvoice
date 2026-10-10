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
 * AN INVOICE POSTS TWO LEGS
 * -------------------------
 *   the document   party moves by the FULL invoice value, against Sales /
 *                  Purchase Account
 *   the receipt    anything settled at the counter moves the party back and
 *                  lands on cash
 *
 * The two legs net to `balanceDue`, which is what the party balance used to
 * move by on its own -- so switching this on never shifted a party balance,
 * it only made the ledger and the cash account tell the truth.
 */

import { invoiceDelta, receiptDelta, round2 } from "./balance.mjs";

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
 * The ledger rows one invoice writes: the document, and -- when something was
 * settled -- both sides of the receipt.
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

  return rows;
}
