// lib/getNextInvoiceNo.js
import Counter from '../models/counterModel';
import Invoice from '../models/invoiceModel';
import { normalizeSeriesCode } from './series.mjs';

/**
 * THE TWO NUMBERS A BILL CARRIES.
 *
 * `invoiceNo` is the firm's own sequence: unbroken, unique, never printed,
 * and what every lookup in this app joins on. `getNextInvoiceNo` below issues
 * it, exactly as it always has.
 *
 * `seriesNo` is the running number INSIDE one series and one financial year,
 * and it is the one the customer sees (as `voucherNo`, composed in
 * lib/series.mjs). `getNextSeriesNo` issues that, from its own counter row.
 *
 * They are separate because the second one restarts: TAX's first bill of
 * 2026-27 and RETAIL's first are both 1. Had the printed number simply become
 * `invoiceNo`, adding a series would have renumbered bills already issued and
 * broken every link to them -- see NUMBERING in lib/series.mjs.
 */

/**
 * Atomically reserve the next invoice number.
 *
 * Pass the active session when called inside a transaction, so a rollback also
 * releases the number instead of burning it.
 *
 * The counter is first nudged past the highest invoice that actually exists.
 * Without that, a fresh counter starts at 1 and collides with every invoice
 * already in the book — and numbers set by hand on the form (or by a
 * renumbering edit) would otherwise leave the counter behind reality.
 */
export const getNextInvoiceNo = async (session = null) => {
  const opts = session ? { session } : {};

  const highest = await Invoice.findOne({}, { invoiceNo: 1 }, opts)
    .sort({ invoiceNo: -1 })
    .lean();

  if (highest?.invoiceNo) {
    await Counter.updateOne(
      { name: 'invoiceNo' },
      { $max: { value: Number(highest.invoiceNo) } },
      { upsert: true, ...opts }
    );
  }

  const counter = await Counter.findOneAndUpdate(
    { name: 'invoiceNo' },
    { $inc: { value: 1 } },
    { new: true, upsert: true, ...opts }
  );

  return counter.value;
};

/** Keep the counter at or above a number that was chosen by hand. */
export const raiseInvoiceCounter = async (invoiceNo, session = null) => {
  const opts = session ? { session } : {};
  await Counter.updateOne(
    { name: 'invoiceNo' },
    { $max: { value: Number(invoiceNo) } },
    { upsert: true, ...opts }
  );
};

/* ─────────────────── the running number inside one series ─────────────────── */

/**
 * The counter row one series' numbering lives in.
 *
 * One row per series per financial year, which is what makes the number
 * restart in April without anything having to reset it: a new year simply
 * asks a counter that does not exist yet, and an upsert starts it at 1.
 *
 * The code is normalised the same way it is stored on the bill, so "tax" and
 * "TAX" cannot end up counting in two different rows and issuing the same
 * number twice.
 */
export const seriesCounterName = (series, finYear) =>
  `invoiceNo:${normalizeSeriesCode(series)}:${Math.trunc(Number(finYear))}`;

/**
 * Atomically reserve the next number within a series and financial year.
 *
 * Same shape as `getNextInvoiceNo` above, and for the same reasons: pass the
 * session so a rolled-back save releases the number instead of burning it,
 * and nudge the counter past the highest number that actually exists first --
 * a counter that starts at 1 against a series already in use would hand out
 * numbers that collide, and the unique index would turn each one into a
 * failed save.
 *
 * Returns null when there is no series: such a bill has no running number,
 * prints `invoiceNo` as it always did, and is deliberately left out of the
 * partial unique index in models/invoiceModel.js.
 */
export const getNextSeriesNo = async ({ series, finYear }, session = null) => {
  const code = normalizeSeriesCode(series);
  const year = Math.trunc(Number(finYear));
  if (!code || !Number.isFinite(year)) return null;

  const opts = session ? { session } : {};
  const name = seriesCounterName(code, year);

  const highest = await Invoice.findOne(
    { series: code, finYear: year },
    { seriesNo: 1 },
    opts
  )
    .sort({ seriesNo: -1 })
    .lean();

  if (highest?.seriesNo) {
    await Counter.updateOne(
      { name },
      { $max: { value: Number(highest.seriesNo) } },
      { upsert: true, ...opts }
    );
  }

  const counter = await Counter.findOneAndUpdate(
    { name },
    { $inc: { value: 1 } },
    { new: true, upsert: true, ...opts }
  );

  return counter.value;
};
