/**
 * Digit identifiers as text.
 *
 * (The file is named for `phone`, which was the first field to need this.
 * `pincode` has since joined it; both are handled by the same rule.)
 *
 * `customers.phone` was declared `type: Number`, which is wrong for an
 * identifier made of digits:
 *
 *   "09811122233"               ->  9811122233   the leading zero is gone
 *   "+91 98111 22233"           ->  null         not a number at all
 *   "98111 22233, 98222 33344"  ->  null         two numbers never fit
 *
 * `customers.pincode` was the same mistake for the same reason: a postal code
 * is an identifier, not a quantity.
 *
 * Both are Strings now. This module holds the rule for turning a value that was
 * stored as a number back into the digits it was meant to be, so the migration
 * script and its tests share one definition.
 *
 * Dependency-free on purpose: scripts/phone-to-string.test.mjs runs it under
 * bare node, with no database driver loaded.
 */

/**
 * What a stored phone should become, or `null` when it needs no change.
 *
 * Returning `null` rather than the unchanged value keeps a migration plan to
 * real work only — a row already holding a string is not rewritten.
 */
export function phoneToString(value) {
  // Already text, or genuinely absent. An empty string is blank, not wrong.
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return null;

  if (typeof value === "number") {
    // Neither of these can have come from a phone number. Blank the field
    // rather than writing the word "NaN" into it.
    if (!Number.isFinite(value)) return "";
    // No exponent notation and no decimal point: a phone is plain digits.
    // `Math.trunc(Math.abs())` also drops a sign that should never be there.
    return BigInt(Math.trunc(Math.abs(value))).toString();
  }

  // A Date, an object, anything else — not a phone number.
  return "";
}

/** The records whose `field` is not already a string. */
export function planFieldConversion(records = [], field = "phone") {
  const plan = [];

  for (const record of records) {
    const value = record[field];
    const next = phoneToString(value);
    if (next === null) continue;

    plan.push({
      _id: String(record._id),
      name: record.name,
      field,
      from: value,
      fromType: value === null ? "null" : typeof value,
      to: next,
    });
  }

  return plan;
}

/** `planFieldConversion` for the phone field. */
export const planPhoneConversion = (allCustomers = []) =>
  planFieldConversion(allCustomers, "phone");

/**
 * A 10-digit Indian mobile stored as a number comes back nine digits long,
 * because the leading zero went when it was first written. The digits that
 * survive are kept as they are -- inventing the zero back would be worse --
 * but the run says which rows to check by hand.
 */
export const looksTruncated = (row) =>
  (row.field ?? "phone") === "phone" &&
  typeof row.from === "number" &&
  Number.isFinite(row.from) &&
  String(Math.trunc(row.from)).length === 9;
