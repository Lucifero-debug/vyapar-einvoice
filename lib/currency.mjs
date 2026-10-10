/**
 * Money formatting, in one place.
 *
 * Pure and dependency-free on purpose, like the rest of lib/*.mjs, so `node`
 * can run it directly in a test without pulling in Mongoose or React.
 */

/**
 * An amount as rupees, Indian digit grouping, always two decimals.
 *
 *   1234567.5  ->  "Rs 12,34,567.50"   (lakh/crore grouping, not thousands)
 *   0          ->  "Rs 0.00"
 *   null       ->  "Rs 0.00"
 *
 * Non-numeric input reads as 0 rather than printing "NaN" at a customer.
 */
export const formatINR = (value) =>
  `₹${(Number(value) || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
