/**
 * The HSN code-wise summary of an invoice, derived from its line items.
 *
 * WHY THIS IS DERIVED, NOT STORED
 * -------------------------------
 * The sale and purchase forms compute this summary and send it with the
 * invoice as `hsnTotals`, one row per HSN code. The schema declared only
 * `{ hsn, amount }` of the four fields sent, so Mongoose strict mode dropped
 * `gstRate` and `total` on every save. Read back, a row was rate 0 and total
 * 0, and the printed bill -- which showed the taxable value as total minus
 * GST -- put the tax itself in that column as a negative number.
 *
 * The schema is fixed, but the lines were always the authority: every figure
 * here is a pure function of them, so the summary cannot drift from the bill
 * it summarises, and invoices saved before the fix still print correctly.
 *
 * Used by the print page (app/invoice/page.js) and by the backfill script
 * (scripts/backfill-hsn-totals.mjs), which must agree by construction.
 */

import { round2 } from "./balance.mjs";

/**
 * Taxable value of one line.
 *
 * `??` rather than `||`: a free line, or one discounted to nothing, has a
 * taxableAmount of 0, which is falsy -- falling back would take it at cost x
 * quantity and charge full GST on a line worth nothing.
 */
export const lineTaxable = (item) =>
  Number(
    item.taxableAmount ?? (Number(item.cost) || 0) * (Number(item.quantity) || 0)
  ) || 0;

/**
 * Group the lines by HSN code.
 *
 * Returns { [hsn]: { gstRate, taxable, gstAmount, total } }. The rate is the
 * one carried by the first line of the group, which is how the forms group
 * them too -- an HSN code has a single rate.
 */
export function buildHsnSummary(items = []) {
  const summary = {};

  for (const item of items) {
    const hsn = item.hsn || "N/A";
    const taxable = lineTaxable(item);
    const gstRate = Number(item.gstRate) || 0;
    const gstAmount = (taxable * gstRate) / 100;

    const row =
      summary[hsn] ||
      (summary[hsn] = { gstRate, taxable: 0, gstAmount: 0, total: 0 });

    row.taxable += taxable;
    row.gstAmount += gstAmount;
    // `??` again: a line totalling 0 is a real total, not a missing one.
    row.total += Number(item.total ?? taxable + gstAmount) || 0;
  }

  // Round once, at the end. Every figure here is money, and summing raw
  // floats leaves the group a hair off -- 519.20 - 79.20 came to
  // 440.00000000000006, so `taxable` and `total - gstAmount` disagreed.
  for (const row of Object.values(summary)) {
    row.taxable = round2(row.taxable);
    row.gstAmount = round2(row.gstAmount);
    row.total = round2(row.total);
  }

  return summary;
}

/** The three columns that foot the printed summary. */
export function hsnGrandTotal(summary) {
  const grand = Object.values(summary).reduce(
    (acc, d) => ({
      taxable: acc.taxable + d.taxable,
      gstAmount: acc.gstAmount + d.gstAmount,
      total: acc.total + d.total,
    }),
    { taxable: 0, gstAmount: 0, total: 0 }
  );

  return {
    taxable: round2(grand.taxable),
    gstAmount: round2(grand.gstAmount),
    total: round2(grand.total),
  };
}

/**
 * The stored shape, as `models/invoiceModel.js` declares it.
 *
 * Note `amount` is the GST charged on the group, NOT its taxable value --
 * the field was named before the others existed. Taxable value is recovered
 * as `total - amount`, which is exactly what went wrong when `total` was
 * being dropped.
 */
export function hsnTotalsForStorage(items = []) {
  return Object.entries(buildHsnSummary(items)).map(([hsn, d]) => ({
    hsn,
    gstRate: round2(d.gstRate),
    amount: round2(d.gstAmount),
    total: round2(d.total),
  }));
}
