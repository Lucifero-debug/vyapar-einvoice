/**
 * Splitting GST into its two halves for a local (intra-state) supply.
 *
 * `(total / 2).toFixed(2)` printed twice is wrong half the time: whenever the
 * tax lands on an odd number of paise, SGST + CGST comes to a paisa more or
 * less than the tax actually charged, and the invoice fails to add up. On a
 * GST invoice the two halves have to reconcile to the tax exactly.
 *
 * Split in paise so nothing is lost, and give the odd paisa to CGST. Which
 * half carries it is arbitrary; that it is carried, and only once, is not.
 */

import { round2 } from "./balance.mjs";

export function splitGst(total) {
  const paise = Math.round((Number(total) || 0) * 100);
  const half = Math.trunc(paise / 2);
  const rest = paise - half;

  // Negative totals (a return) keep the larger magnitude on the same side.
  return { sgst: round2(half / 100), cgst: round2(rest / 100) };
}

/**
 * GST state codes are two digits -- Delhi is "07", not 7. They were stored as
 * numbers, which dropped the leading zero, so keep them as strings and pad
 * any single digit (including values saved before this fix).
 */
export function normalizeStateCode(value) {
  if (value === null || value === undefined) return "";
  const digits = String(value).replace(/\D/g, "").slice(0, 2);
  if (!digits || Number(digits) === 0) return "";
  return digits.padStart(2, "0");
}

/**
 * Intra-state or inter-state, from the two state codes.
 *
 * "local" is CGST + SGST and "central" is IGST, which are the two values the
 * rest of this app uses (`lib/invoiceGl.mjs` picks the posting heads off it
 * and `lib/gstReturns.mjs` picks the GSTR-1 table). Returns null when either
 * code is missing, because the honest answer then is "nobody has told me" --
 * and a `|| "local"` fallback is a tax decision made by a default.
 *
 * SYMMETRIC, and deliberately so: it only asks whether the two codes are
 * equal. A sale puts our code first and a purchase the supplier's, and the
 * answer is the same either way, so no caller has to get the order right.
 *
 * Lives here rather than beside the one caller it began with. It was written
 * in lib/invoiceImport.mjs for read-in bills, which left the billing form --
 * where every typed invoice gets its tax type -- setting it by hand from two
 * radio buttons. One rule, in the module that already owns the state code.
 */
export function taxTypeFor(sellerStateCode, buyerStateCode) {
  const seller = normalizeStateCode(sellerStateCode);
  const buyer = normalizeStateCode(buyerStateCode);
  if (!seller || !buyer) return null;
  return seller === buyer ? "local" : "central";
}
