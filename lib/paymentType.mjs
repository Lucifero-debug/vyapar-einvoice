/**
 * Which set of books a payment settles through.
 *
 * Kept free of Mongoose, and separate from `cashAccount.mjs`, so the rule
 * itself can be exercised by the fixture tests under bare node -- the same
 * reason `itemLedger.mjs` was split out of `invoicePosting.mjs`.
 *
 * The invoice form offers Cash and Cheque today. Anything that is not literally
 * cash settles through the bank, so adding UPI, NEFT or a card to that dropdown
 * needs no change here.
 */

export const CASH_ACCOUNT_NAME = "Cash";
export const BANK_ACCOUNT_NAME = "Bank";

/** True for cash in hand. An unset or 'Credit' payment type counts as cash. */
export const isCashPayment = (paymentType) =>
  !paymentType || /^(cash|credit)$/i.test(String(paymentType).trim());

/** The Customer `group` an account of this kind is filed under. */
export const paymentAccountGroup = (paymentType) =>
  isCashPayment(paymentType) ? "cash" : "bank";

/** What to call the account when the books do not have one yet. */
export const defaultAccountName = (paymentType) =>
  isCashPayment(paymentType) ? CASH_ACCOUNT_NAME : BANK_ACCOUNT_NAME;
