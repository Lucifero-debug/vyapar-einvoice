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
