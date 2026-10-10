/**
 * Where money taken at the counter lands.
 *
 * An invoice can be part- or fully paid on the spot. That payment needs a real
 * account to sit in, or the cash leg has nowhere to go and the entry is
 * half-written. Vouchers already treat cash and bank as ordinary Customer docs
 * grouped under 'cash' / 'bank' (see the account pickers in /voucheradd), so
 * invoices use the same accounts rather than inventing a parallel notion.
 *
 * WHICH account depends on how the money actually moved. The invoice form asks
 * (Cash / Cheque / ...), and that answer used to be thrown away: every receipt
 * landed in the cash account, so a cheque banked on Monday showed up as notes
 * in the till and cash-in-hand was wrong from the first week.
 *
 * Resolution order for a given payment type, deliberately boring:
 *   1. an account named exactly as the payment type ('Cheque', 'HDFC Bank')
 *   2. the business's own account in the matching group ('cash' / 'bank'),
 *      oldest first so the choice is stable across calls
 *   3. an account literally named 'Cash' / 'Bank'
 *   4. create one
 *
 * The `find*` variants never create. Reversal paths use them: if no such
 * account exists then no invoice can ever have posted to it, and conjuring one
 * during a delete would be surprising.
 */

import Customer from "../models/custModel";
import {
  BANK_ACCOUNT_NAME,
  CASH_ACCOUNT_NAME,
  defaultAccountName as defaultNameFor,
  paymentAccountGroup as groupFor,
} from "./paymentType.mjs";

export { BANK_ACCOUNT_NAME, CASH_ACCOUNT_NAME };

/** Locate the account a payment of this type settles through. Never creates. */
export async function findPaymentAccount(paymentType, session) {
  const label = String(paymentType || "").trim();

  // An account named for the payment method itself wins — it lets the shop
  // keep 'Cheque' and 'UPI' as separate books if they want to.
  if (label) {
    const byName = await Customer.findOne({ name: label }, null, { session }).exec();
    if (byName) return byName;
  }

  const group = groupFor(paymentType);
  const byGroup = await Customer.findOne(
    { group: new RegExp(`^${group}$`, "i") },
    null,
    { session }
  )
    .sort({ _id: 1 })
    .exec();
  if (byGroup) return byGroup;

  return Customer.findOne({ name: defaultNameFor(paymentType) }, null, {
    session,
  }).exec();
}

/** As `findPaymentAccount`, but creates the account when there isn't one. */
export async function resolvePaymentAccount(paymentType, session) {
  const existing = await findPaymentAccount(paymentType, session);
  if (existing) return existing;

  const name = defaultNameFor(paymentType);
  const [created] = await Customer.create(
    [
      {
        name,
        group: name,
        openingBal: 0,
        openingMode: "Dr",
        lastBal: 0,
        lastMode: "Dr",
      },
    ],
    { session }
  );

  return created;
}

/* -- Kept for callers that genuinely mean "the cash account", not "wherever
      this particular payment went". ------------------------------------- */

export const findCashAccount = (session) => findPaymentAccount("Cash", session);
export const resolveCashAccount = (session) => resolvePaymentAccount("Cash", session);
