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
 * Used by the print page (components/InvoiceDocument.jsx), the billing
 * screens and the server (via lib/billingMath.mjs), the GL (lib/invoiceGl.mjs),
 * the GST returns (lib/gstReturns.mjs) and the backfill script
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

/** The code a line is grouped under. A blank HSN groups as `missing`. */
export const hsnOf = (item, missing = "N/A") => String(item?.hsn ?? "").trim() || missing;

/** One group per HSN code AND rate. See `hsnRateGroups`. */
export const hsnKey = (hsn, gstRate) => `${hsn}@${Number(gstRate) || 0}`;

/**
 * THE ONE PLACE LINES ARE GROUPED FOR GST.
 *
 * Every HSN summary in the app -- the billing screen's panel, the stored
 * `hsnTotals`, the printed bill, the GL's taxable value and tax, and the GST
 * returns -- is this function. They used to be three: two of them keyed on
 * the HSN code alone and kept the FIRST line's rate, so a 5% and an 18% item
 * sharing a code printed as one row "at 5%" carrying both taxes, and the
 * screen, the print and table 12 of GSTR-1 could each disagree by a paisa.
 *
 * A group is one HSN code at one rate. An HSN code normally has one rate,
 * but not always (the rate can turn on the value of the item, and a rate
 * change mid-year puts both on the books) -- and when it has two, filing
 * them as one is simply wrong.
 *
 * ROUNDING: lines are summed raw and each group is rounded ONCE. Lines are
 * not rounded (`recalcItem` keeps its dust, see lib/billingMath.mjs), and
 * rounding a running total line by line loses or gains a paisa per line.
 * Anything totalled across groups adds the ROUNDED group figures, so the
 * footing on the bill is the sum of the rows printed above it.
 *
 *   source "derived"  the tax is taxable x rate, worked out from the line --
 *                     the print and the GL, which must agree with each other
 *   source "stored"   the tax is the line's stored `gstAmount` -- the GST
 *                     returns, which file what the bill said (see the note
 *                     in lib/gstReturns.mjs)
 *   missing           what a line with no HSN groups under
 *
 * Returns the groups in the order their first line appears, each
 *   { key, hsn, gstRate, quantity, taxable, gstAmount, total, name, uqc, unit }
 * where name/uqc/unit are the first line's (the returns describe a group by
 * them). `quantity` is summed raw; money is rounded.
 */
export function hsnRateGroups(items = [], { source = "derived", missing = "N/A" } = {}) {
  const groups = new Map();

  for (const item of items || []) {
    if (!item) continue;
    const hsn = hsnOf(item, missing);
    const gstRate = Number(item.gstRate) || 0;
    const stored = source === "stored";
    const taxable = stored ? Number(item.taxableAmount) || 0 : lineTaxable(item);
    const gstAmount = stored ? Number(item.gstAmount) || 0 : (taxable * gstRate) / 100;
    const key = hsnKey(hsn, gstRate);

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        hsn,
        gstRate,
        quantity: 0,
        taxable: 0,
        gstAmount: 0,
        total: 0,
        name: String(item.name ?? "").trim(),
        uqc: String(item.uqc ?? "").trim(),
        unit: String(item.unit ?? "").trim(),
      };
      groups.set(key, group);
    }

    group.quantity += Number(item.quantity) || 0;
    group.taxable += taxable;
    group.gstAmount += gstAmount;
    // `??`: a line totalling 0 is a real total, not a missing one.
    group.total += Number(item.total ?? taxable + gstAmount) || 0;
  }

  // Round once, at the end. Summing raw floats leaves the group a hair off --
  // 519.20 - 79.20 came to 440.00000000000006, so `taxable` and
  // `total - gstAmount` disagreed.
  return [...groups.values()].map((g) => ({
    ...g,
    taxable: round2(g.taxable),
    gstAmount: round2(g.gstAmount),
    total: round2(g.total),
  }));
}

/**
 * The HSN summary as an object, keyed by `hsnKey` (code AND rate).
 *
 * Returns { [hsn@rate]: { hsn, gstRate, taxable, gstAmount, total, ... } }.
 * Render `row.hsn`, not the key.
 */
export function buildHsnSummary(items = []) {
  const summary = {};
  for (const group of hsnRateGroups(items)) summary[group.key] = group;
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
  return hsnRateGroups(items).map((d) => ({
    hsn: d.hsn,
    gstRate: round2(d.gstRate),
    amount: round2(d.gstAmount),
    total: round2(d.total),
  }));
}
