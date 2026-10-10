/**
 * Clearing figures that were never actually entered.
 *
 * The master forms initialised every numeric box to 0 and coerced an empty box
 * straight back to 0 on each keystroke, so a price nobody had filled in was
 * saved as a real zero. Reopening the item then showed "0" rather than an empty
 * field, and there was no way to tell "free" from "not priced yet".
 *
 * The forms now keep a blank blank. This clears the zeros those forms already
 * wrote, by UNSETTING the field rather than storing null -- an absent field and
 * a 0 read identically through `Number(x) || 0`, so nothing downstream changes
 * behaviour; only what the form shows does.
 *
 * ONLY optional figures are touched. Quantities and balances are left alone:
 * an opening stock of 0 is a real statement, and the balance fields are
 * system-owned.
 *
 * Dependency-free so scripts/blank-zeros.test.mjs runs it under bare node.
 */

/** Item master fields where 0 means "never filled in". */
export const ITEM_FIELDS = [
  "salePrice",
  "cost",
  "purchasePrice",
  "mrp",
  "discount",
  "weight",
];

/** Customer master fields where 0 means "never filled in". */
export const CUSTOMER_FIELDS = ["discount", "interest"];

/**
 * True when a stored value is a zero that the old form wrote.
 *
 * `0`, `"0"` and `""` all qualify. A genuine figure, including a negative one,
 * does not.
 */
export const isUnsetZero = (value) => {
  if (value === null || value === undefined) return false; // already absent
  if (typeof value === "string" && value.trim() === "") return true;
  const n = Number(value);
  return Number.isFinite(n) && n === 0;
};

/**
 * Which fields of which records would be cleared.
 *
 * Returns [{ _id, name, fields: [...] }], carrying only records with work to
 * do, so a dry run prints exactly what a write would change.
 */
export function planBlanking(records = [], fields = []) {
  const plan = [];

  for (const record of records) {
    const hits = fields.filter((f) => isUnsetZero(record[f]));
    if (!hits.length) continue;
    plan.push({ _id: String(record._id), name: record.name, fields: hits });
  }

  return plan;
}

/** The `$unset` document for one planned record. */
export const unsetFor = (entry) =>
  Object.fromEntries(entry.fields.map((f) => [f, ""]));
