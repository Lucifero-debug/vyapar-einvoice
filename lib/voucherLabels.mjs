/**
 * How one voucher is named in a list of vouchers.
 *
 * Pure, like the rest of lib/*.mjs, so `node scripts/voucher-labels.test.mjs`
 * runs it directly.
 *
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The dashboard's Alter and Delete pickers listed every bank voucher by
 * `acName` -- the account the money moved THROUGH. A firm banking with one
 * bank therefore got a list like:
 *
 *     BANK OF BARODA
 *     BANK OF BARODA
 *     BANK OF BARODA
 *     BANK OF BARODA
 *
 * Four different vouchers, four identical rows, and no way to tell which one
 * you were about to open or delete. Cash and Contra had it too. Journal had
 * already been given narration instead, which is why it looked fine -- the
 * same problem was fixed there once without noticing it applied to the other
 * three.
 *
 * It was also feeding cmdk four items with the same `value`, which is the
 * key it filters and highlights by.
 *
 * So a voucher is named by what makes it ITSELF, not by what it has in
 * common with every other voucher in the section:
 *
 *     18/10/2026 · ₹10,000.00 · Neft
 *
 * Date first because that is what somebody scans for, then the amount, then
 * what it was for. The popover is 320px, so this is about as much as fits
 * before it truncates -- which is why the account name is the FALLBACK for
 * the last part rather than a fifth field. A voucher with a narration is
 * better identified by it; one without falls back to the account, which is
 * at least something.
 *
 * The section heading already says Bank, Cash, Journal or Contra, so the
 * kind is not repeated here.
 */

import { formatINR } from "./currency.mjs";
// dd/mm/yyyy, read in India. Named for the IRP because that is the one place
// the format is a protocol requirement rather than a preference, but it is
// the same format a shopkeeper reads -- and a second date formatter here
// would be a second place for a timezone to be got wrong (lib/istDate.mjs
// says what that costs).
import { formatIrpDate } from "./istDate.mjs";
import { lineTotals } from "./voucherKinds.mjs";

const text = (value) => String(value ?? "").trim();

/** How long a narration may be before it is cut. */
export const NARRATION_MAX = 40;

/**
 * What the voucher is worth: the larger side of its lines.
 *
 * Not the sum of both. A receipt's lines are all credits and a journal's
 * balance Dr = Cr, so adding the two columns would double a journal and
 * report a receipt correctly -- the same figure meaning two different things
 * depending on the kind.
 */
export const voucherAmount = (voucher) => {
  const { debit, credit } = lineTotals(voucher?.customers);
  return Math.max(debit, credit);
};

/**
 * The account a voucher is about: the cash or bank account it moved through,
 * or -- for a journal, which has none -- the first account its lines name.
 */
export const voucherAccount = (voucher) =>
  text(voucher?.acName) ||
  text(voucher?.accountName) ||
  text(voucher?.customers?.[0]?.name);

/** A narration, cut to something a 320px row can show. */
export const shortNarration = (value) => {
  const narration = text(value).replace(/\s+/g, " ");
  if (narration.length <= NARRATION_MAX) return narration;
  return `${narration.slice(0, NARRATION_MAX - 1).trimEnd()}…`;
};

/**
 * One row in a voucher picker.
 *
 * Never empty: a voucher with no date, no lines and no narration still has
 * to be selectable, so it falls back to its id. A blank row that opens
 * something is worse than an ugly one.
 */
export const voucherPickerLabel = (voucher) => {
  const date = formatIrpDate(voucher?.date);
  const amount = voucherAmount(voucher);
  const detail = shortNarration(voucher?.narration) || voucherAccount(voucher);

  const parts = [date, amount ? formatINR(amount) : "", detail].filter(Boolean);

  return parts.length ? parts.join(" · ") : text(voucher?._id) || text(voucher?.id);
};
