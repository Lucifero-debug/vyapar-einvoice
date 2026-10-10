/**
 * Fixture tests for the hsnTotals backfill plan.
 *
 *   node scripts/backfill-hsn-totals.test.mjs
 */

import assert from "node:assert/strict";
import { planBackfill, diagnoseInvoice } from "./backfill-hsn-totals.mjs";
import { hsnTotalsForStorage, buildHsnSummary } from "../lib/hsnTotals.mjs";
import { round2 } from "../lib/balance.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/** One line: 11 x 40 at 18%, no discount. Taxable 440, GST 79.20, total 519.20. */
const LINE = {
  name: "Item No.1",
  quantity: 11,
  cost: 40,
  discount: 0,
  hsn: "1210",
  gstRate: 18,
  taxableAmount: 440,
  total: 519.2,
};

/** What the schema actually left behind: hsn and amount, nothing else. */
const truncatedRow = () => ({ hsn: "1210", amount: 79.2 });

const invoice = (over = {}) => ({
  _id: "64b000000000000000000001",
  invoiceNo: 4,
  type: "Sale",
  date: "2026-09-20",
  items: [LINE],
  hsnTotals: [truncatedRow()],
  ...over,
});

/* ------------------------------------------------------------ derivation -- */

test("derives the row the truncated one should have been", () => {
  const [row] = hsnTotalsForStorage([LINE]);
  assert.deepEqual(row, { hsn: "1210", gstRate: 18, amount: 79.2, total: 519.2 });
  // Taxable is recovered as total - amount; this is the figure that printed
  // as -79.20 while total was being dropped. Rounded, because subtracting two
  // stored currency figures is float arithmetic.
  assert.equal(round2(row.total - row.amount), 440);
});

test("a free line is not charged GST on its cost", () => {
  const free = { ...LINE, cost: 0, taxableAmount: 0, total: 0 };
  const [row] = hsnTotalsForStorage([free]);
  assert.equal(row.amount, 0);
  assert.equal(row.total, 0);
});

test("lines sharing an HSN code are summed into one row", () => {
  const rows = hsnTotalsForStorage([LINE, { ...LINE, taxableAmount: 150, total: 177 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 106.2); // 79.20 + 27.00
  assert.equal(rows[0].total, 696.2);
});

test("distinct HSN codes stay distinct", () => {
  const other = { ...LINE, hsn: "3004", gstRate: 12, taxableAmount: 100, total: 112 };
  const rows = hsnTotalsForStorage([LINE, other]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.hsn).sort(), ["1210", "3004"]);
});

test("a line with no HSN code groups under N/A rather than vanishing", () => {
  const rows = hsnTotalsForStorage([{ ...LINE, hsn: undefined }]);
  assert.equal(rows[0].hsn, "N/A");
  assert.equal(rows[0].total, 519.2);
});

test("float drift is rounded out of the stored figures", () => {
  // 0.1 + 0.2 territory: 33.33 x 18% is 5.9994 before rounding.
  const [row] = hsnTotalsForStorage([
    { ...LINE, taxableAmount: 33.33, total: 39.33 },
  ]);
  assert.equal(row.amount, 6);
  assert.equal(String(row.amount).length <= 5, true);
});

/* ------------------------------------------------------------- diagnosis -- */

test("names the dropped fields", () => {
  const problems = diagnoseInvoice([truncatedRow()], hsnTotalsForStorage([LINE]));
  assert.ok(problems.includes("gstRate dropped"));
  assert.ok(problems.includes("total dropped"));
});

test("a complete, correct row is not a problem", () => {
  const derived = hsnTotalsForStorage([LINE]);
  assert.deepEqual(diagnoseInvoice(derived, derived), []);
});

test("an amount that disagrees with the lines is reported", () => {
  const derived = hsnTotalsForStorage([LINE]);
  const stale = [{ ...derived[0], amount: 50 }];
  const problems = diagnoseInvoice(stale, derived);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /gst 50\.00 → 79\.20/);
});

test("a stored HSN code the lines no longer contain is reported", () => {
  const derived = hsnTotalsForStorage([LINE]);
  const problems = diagnoseInvoice([...derived, { hsn: "9999", gstRate: 5, amount: 1, total: 21 }], derived);
  assert.ok(problems.some((p) => p.includes("hsn 9999 not in the lines")));
});

test("half a paisa of float drift is not treated as a difference", () => {
  const derived = hsnTotalsForStorage([LINE]);
  const jittery = [{ ...derived[0], amount: derived[0].amount + 0.004 }];
  assert.deepEqual(diagnoseInvoice(jittery, derived), []);
});

/* ------------------------------------------------------------------ plan -- */

test("plans the truncated invoice and derives its replacement", () => {
  const { plan, counts } = planBackfill({ allInvoices: [invoice()] });
  assert.equal(plan.length, 1);
  assert.equal(counts.rowsMissingGstRate, 1);
  assert.equal(counts.rowsMissingTotal, 1);
  assert.deepEqual(plan[0].derived, [
    { hsn: "1210", gstRate: 18, amount: 79.2, total: 519.2 },
  ]);
});

test("is idempotent — a backfilled invoice is not planned again", () => {
  const first = planBackfill({ allInvoices: [invoice()] });
  const second = planBackfill({
    allInvoices: [invoice({ hsnTotals: first.plan[0].derived })],
  });
  assert.equal(second.plan.length, 0);
});

test("--all rewrites an invoice that is already correct", () => {
  const good = invoice({ hsnTotals: hsnTotalsForStorage([LINE]) });
  assert.equal(planBackfill({ allInvoices: [good] }).plan.length, 0);
  assert.equal(planBackfill({ allInvoices: [good], rewriteAll: true }).plan.length, 1);
});

test("an invoice with no line items is skipped, never emptied", () => {
  const { plan, skipped } = planBackfill({ allInvoices: [invoice({ items: [] })] });
  assert.equal(plan.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].why, /no line items/);
});

test("an invoice with items but no stored rows gets them", () => {
  const { plan } = planBackfill({ allInvoices: [invoice({ hsnTotals: [] })] });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].problems, ["no stored rows"]);
});

test("the plan never touches anything but hsnTotals", () => {
  const { plan } = planBackfill({ allInvoices: [invoice()] });
  assert.deepEqual(Object.keys(plan[0]).sort(), [
    "_id", "date", "derived", "invoiceNo", "problems", "stored", "type",
  ]);
});

/* ------------------------------ the summary the print page renders -------- */

test("the printed summary and the stored rows come from one derivation", () => {
  const summary = buildHsnSummary([LINE]);
  const [stored] = hsnTotalsForStorage([LINE]);
  assert.equal(summary["1210"].taxable, round2(stored.total - stored.amount));
  assert.equal(summary["1210"].gstAmount, stored.amount);
  assert.equal(summary["1210"].total, stored.total);
});

console.log(
  process.exitCode
    ? "\nSome assertions failed.\n"
    : `\n${passed} assertions passed.\n`
);
