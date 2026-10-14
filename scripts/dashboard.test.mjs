/**
 * The owner's dashboard: scripts/dashboard.test.mjs
 *
 * Plain node, no framework -- `node scripts/dashboard.test.mjs`.
 *
 * WHAT THIS SUITE IS GUARDING. A dashboard is read at a glance and acted on,
 * so its failure mode is not a crash but a plausible wrong number. Four
 * things matter most:
 *
 *   1. A RETURN IS NOT A SALE, and a purchase is not a sale either. Gross,
 *      returns and net are three separate figures and stay that way.
 *
 *   2. A BALANCE IS NOT A PERIOD FIGURE. The date filter must not touch the
 *      receivables, the payables or the stock.
 *
 *   3. THE SIGN DECIDES WHAT A BALANCE MEANS. A customer in credit has paid
 *      in advance; they are not a payable. A supplier in debit is the mirror.
 *
 *   4. NOTHING IS INVENTED. No due dates exist, so nothing is overdue. No
 *      minimum stock is set on most items, so they are not compared against
 *      a made-up one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CHART_GRAINS,
  COMPARISON_METRICS,
  OVERDUE_UNAVAILABLE,
  PARTY_SIDES,
  PERIOD_PRESETS,
  POINT_IN_TIME,
  DASHBOARD_REASONS,
  STOCK_REASONS,
  STOCK_REASON_LABELS,
  bucketLabel,
  bucketOf,
  comparisonRows,
  compare,
  filterParties,
  fyStart,
  grainFor,
  isPartySide,
  isPreset,
  istIso,
  lowStockRows,
  movedInPeriod,
  onSide,
  paginate,
  partyRows,
  partySummary,
  periodFigures,
  periodProblem,
  previousPeriod,
  resolvePeriod,
  stockReason,
  stockSummary,
  trendMetrics,
  trendSeries,
  vouchersIn,
} from "../lib/dashboard.mjs";
import { documentsFor } from "../lib/salesReports.mjs";
import { buildStockIndex } from "../lib/itemStock.mjs";
import { dayIndexToIso, istDayIndex, istDayNumber } from "../lib/istDate.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** Comments explain what these files avoid, and greps match the prose. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 15 June 2026, 15:30 IST. Fixed, so nothing here depends on the clock. */
const NOW = Date.UTC(2026, 5, 15, 10, 0, 0);

const invoice = (over = {}) => ({
  invoiceNo: 1,
  type: "Sale",
  return: false,
  date: "2026-06-10",
  customer: { name: "Acme Traders" },
  taxType: "local",
  gst: 180,
  totalAmount: 1180,
  // Charged 1500: 1180 of items plus 320 of freight. So the invoice value is
  // not the taxable value and not the taxable plus tax either.
  finalAmount: 1500,
  received: 0,
  balanceDue: 1500,
  ...over,
});

const party = (over = {}) => ({
  _id: "a1",
  name: "Acme Traders",
  group: "Sundry Debtors",
  city: "Delhi",
  lastBal: 1500,
  lastMode: "Dr",
  ...over,
});

console.log("\n--- the period, and that it is the same period everywhere ---");

test("every preset resolves to two IST dates", () => {
  assert.deepEqual(PERIOD_PRESETS, [
    "today", "last7", "last30", "thisMonth", "prevMonth", "thisFy", "custom",
  ]);
  assert.equal(isPreset("thisMonth"), true);
  assert.equal(isPreset("lastYear"), false);
  assert.equal(isPreset(""), false);

  const at = (preset, extra) => resolvePeriod({ preset, now: NOW, ...extra });
  assert.deepEqual(
    [at("today").from, at("today").to],
    ["2026-06-15", "2026-06-15"]
  );
  // Seven days INCLUDING today, so "last 7 days" is seven days of books.
  assert.deepEqual([at("last7").from, at("last7").to], ["2026-06-09", "2026-06-15"]);
  assert.deepEqual([at("last30").from, at("last30").to], ["2026-05-17", "2026-06-15"]);
  assert.deepEqual([at("thisMonth").from, at("thisMonth").to], ["2026-06-01", "2026-06-30"]);
  assert.deepEqual([at("prevMonth").from, at("prevMonth").to], ["2026-05-01", "2026-05-31"]);
  assert.deepEqual(
    [at("custom", { from: "2026-01-05", to: "2026-02-09" }).from,
     at("custom", { from: "2026-01-05", to: "2026-02-09" }).to],
    ["2026-01-05", "2026-02-09"]
  );
});

test("the financial year runs April to March, as it does in India", () => {
  assert.deepEqual(
    [resolvePeriod({ preset: "thisFy", now: NOW }).from, resolvePeriod({ preset: "thisFy", now: NOW }).to],
    ["2026-04-01", "2027-03-31"]
  );
  // A date in January belongs to the year that started the previous April.
  const jan = Date.UTC(2027, 0, 20);
  assert.deepEqual(
    [resolvePeriod({ preset: "thisFy", now: jan }).from, resolvePeriod({ preset: "thisFy", now: jan }).to],
    ["2026-04-01", "2027-03-31"]
  );
  assert.equal(fyStart({ year: 2026, month: 3 }), 2025);
  assert.equal(fyStart({ year: 2026, month: 4 }), 2026);
  assert.equal(resolvePeriod({ preset: "thisFy", now: NOW }).label, "FY 2026-27");
});

test("a month ends on its own last day, 28, 29, 30 or 31", () => {
  // June has 30 days, so a hard-coded 30 looks right all through this file
  // unless a 31-day month is tried too.
  const at = (now) => resolvePeriod({ preset: "thisMonth", now });
  assert.equal(at(Date.UTC(2026, 6, 10)).to, "2026-07-31", "July");
  assert.equal(at(Date.UTC(2026, 5, 10)).to, "2026-06-30", "June");
  assert.equal(at(Date.UTC(2026, 1, 10)).to, "2026-02-28", "February");
  assert.equal(at(Date.UTC(2028, 1, 10)).to, "2028-02-29", "a leap February");
});

test("a month boundary does not fall off the end of the year", () => {
  const jan = Date.UTC(2026, 0, 10);
  assert.deepEqual(
    [resolvePeriod({ preset: "prevMonth", now: jan }).from, resolvePeriod({ preset: "prevMonth", now: jan }).to],
    ["2025-12-01", "2025-12-31"]
  );
  // And February's length is February's, leap year included.
  const mar = Date.UTC(2028, 2, 10);
  assert.equal(resolvePeriod({ preset: "prevMonth", now: mar }).to, "2028-02-29");
});

test("the period is validated on the server, not only in the form", () => {
  assert.equal(periodProblem({ from: "2026-06-01", to: "2026-06-30" }), null);
  assert.match(periodProblem({ from: "", to: "2026-06-30" }), /both dates/i);
  assert.match(periodProblem({ from: "2026-06-01", to: "" }), /both dates/i);
  assert.match(periodProblem({ from: "not a date", to: "2026-06-30" }), /not a date/);
  assert.match(periodProblem({ from: "2026-06-30", to: "2026-06-01" }), /after its end/);
  // A decade of books to draw one chart is refused rather than attempted.
  assert.match(periodProblem({ from: "2016-01-01", to: "2026-12-31" }), /over three years/);
  assert.equal(periodProblem({ from: "2024-06-01", to: "2026-12-31" }), null);
});

test("an IST date is the IST date, not the server's", () => {
  // 19:00 UTC on 30 June is already 1 July in IST.
  assert.equal(istIso("2026-06-30T19:00:00Z"), "2026-07-01");
  assert.equal(istIso("2026-06-30T12:00:00Z"), "2026-06-30");
  assert.equal(istIso(null), "");
});

console.log("\n--- the comparison compares equal windows ---");

test("a finished month is compared with the whole of the one before", () => {
  const prev = previousPeriod({ from: "2026-05-01", to: "2026-05-31", now: NOW });
  assert.deepEqual([prev.from, prev.to], ["2026-04-01", "2026-04-30"]);
  assert.equal(prev.partial, null, "nothing was cut");
  assert.equal(prev.label, "Apr 2026");
});

test("a month still running is compared with the same elapsed days", () => {
  // This is the commonest way a dashboard invents a collapse in sales: half
  // of June against the whole of May.
  const prev = previousPeriod({ from: "2026-06-01", to: "2026-06-30", now: NOW });
  assert.deepEqual([prev.from, prev.to], ["2026-05-01", "2026-05-15"]);
  assert.match(prev.partial, /first 15 days/);
});

test("only a WHOLE month is compared as a month", () => {
  // A range that starts on the 1st but stops mid-month, or starts mid-month
  // and runs to the end, is a day window -- not "the previous month". Both
  // halves of that test are needed: an earlier version checked neither and a
  // half-month would have been compared against a whole one.
  const fromFirst = previousPeriod({ from: "2026-06-01", to: "2026-06-12", now: NOW });
  assert.deepEqual([fromFirst.from, fromFirst.to], ["2026-05-20", "2026-05-31"]);
  assert.match(fromFirst.label, /12 days before/);

  const toLast = previousPeriod({ from: "2026-06-10", to: "2026-06-30", now: NOW });
  assert.deepEqual([toLast.from, toLast.to], ["2026-05-20", "2026-06-09"]);
  assert.match(toLast.label, /21 days before/);

  // And a whole one still is a month.
  assert.equal(previousPeriod({ from: "2026-05-01", to: "2026-05-31", now: NOW }).label, "Apr 2026");
});

test("a day window is compared with the same number of days before it", () => {
  const prev = previousPeriod({ from: "2026-06-09", to: "2026-06-15", now: NOW });
  assert.deepEqual([prev.from, prev.to], ["2026-06-02", "2026-06-08"]);
  assert.equal(istDayIndex(prev.to) - istDayIndex(prev.from), 6, "seven days, as the period is");
  // And a single day against the day before.
  const one = previousPeriod({ from: "2026-06-15", to: "2026-06-15", now: NOW });
  assert.deepEqual([one.from, one.to], ["2026-06-14", "2026-06-14"]);
});

test("a nonsense window has no comparison rather than a wrong one", () => {
  assert.equal(previousPeriod({ from: "2026-06-30", to: "2026-06-01" }), null);
  assert.equal(previousPeriod({ from: "", to: "" }), null);
});

test("a percentage change from nothing is not a percentage", () => {
  assert.deepEqual(compare(100, 80), { current: 100, previous: 80, diff: 20, pct: 25, direction: "up" });
  assert.deepEqual(compare(80, 100), { current: 80, previous: 100, diff: -20, pct: -20, direction: "down" });
  // No division by zero, and "new" rather than an infinite rise.
  assert.deepEqual(compare(100, 0), { current: 100, previous: 0, diff: 100, pct: null, direction: "new" });
  // Nothing to nothing is the same, not a 0% rise.
  assert.deepEqual(compare(0, 0), { current: 0, previous: 0, diff: 0, pct: null, direction: "same" });
  // A fall from a negative previous still reads as a fall, by magnitude.
  assert.equal(compare(-200, -100).direction, "down");
  assert.equal(compare(-200, -100).pct, -100);
});

console.log("\n--- sales: a return is not a sale, a purchase is not either ---");

test("gross, returns and net are three figures, all GST-inclusive", () => {
  const rows = documentsFor({
    invoices: [
      invoice({ invoiceNo: 1 }),
      invoice({ invoiceNo: 2 }),
      invoice({ invoiceNo: 3, return: true, totalAmount: 236, gst: 36, finalAmount: 300, balanceDue: 300 }),
    ],
    side: "Sale",
    from: "2026-06-01",
    to: "2026-06-30",
  });
  const m = trendMetrics(rows);
  assert.equal(m.gross, 3000, "two bills at 1500, what the parties were charged");
  assert.equal(m.returns, 300);
  assert.equal(m.net, 2700, "gross less returns");
  assert.equal(m.invoices, 2, "the credit note is not a bill");
  assert.equal(m.returnNotes, 1);
  // The average is per BILL. Dividing by all three documents would understate
  // it, and a credit note is not a sale.
  assert.equal(m.average, 1500);
  // The pre-tax figure is carried alongside, not left to be guessed at.
  assert.equal(m.taxable, 1800, "1000 + 1000 - 200");
  assert.equal(m.gst, 324);
  assert.notEqual(m.gross, m.taxable, "the invoice value is not the taxable value");
});

test("an empty period reads as nothing, not as an error", () => {
  const m = trendMetrics([]);
  assert.deepEqual(
    [m.gross, m.returns, m.net, m.invoices, m.average, m.taxable],
    [0, 0, 0, 0, 0, 0]
  );
  assert.equal(m.average, 0, "no bills, no division by zero");
});

test("a purchase never counts towards sales", () => {
  const invoices = [invoice({ invoiceNo: 1 }), invoice({ invoiceNo: 2, type: "Purchase" })];
  const period = { from: "2026-06-01", to: "2026-06-30" };
  assert.equal(trendMetrics(documentsFor({ invoices, side: "Sale", ...period })).gross, 1500);
  assert.equal(trendMetrics(documentsFor({ invoices, side: "Purchase", ...period })).gross, 1500);
  // And they are separate figures on the comparison, not one.
  const figures = periodFigures({ invoices, ...period });
  assert.equal(figures.grossSales, 1500);
  assert.equal(figures.grossPurchases, 1500);
  assert.notEqual(figures.grossSales + figures.grossPurchases, figures.netSales);
});

test("sales are never inferred from money received", () => {
  // A credit sale of 1500 with nothing received is still a sale of 1500.
  const m = trendMetrics(
    documentsFor({
      invoices: [invoice({ received: 0, balanceDue: 1500 })],
      side: "Sale",
      from: "2026-06-01",
      to: "2026-06-30",
    })
  );
  assert.equal(m.gross, 1500);
  const src = code(read("../lib/dashboard.mjs"));
  assert.doesNotMatch(src, /r\.received|\breceived\b\s*\)/, "sales must not read the received column");
});

console.log("\n--- the chart ---");

test("the grain suits the period unless one was asked for", () => {
  assert.deepEqual(CHART_GRAINS, ["day", "week", "month"]);
  assert.equal(grainFor({ from: "2026-06-01", to: "2026-06-30" }), "day");
  assert.equal(grainFor({ from: "2026-01-01", to: "2026-12-31" }), "week");
  assert.equal(grainFor({ from: "2020-01-01", to: "2026-12-31" }), "month");
  // The boundaries themselves, since a day out would be invisible otherwise.
  assert.equal(grainFor({ from: "2026-01-01", to: "2026-02-14" }), "day", "45 days");
  assert.equal(grainFor({ from: "2026-01-01", to: "2026-02-15" }), "week", "46 days");
  // And the week/month boundary, which a year alone does not reach: 18
  // months is still weeks, three years is months.
  assert.equal(grainFor({ from: "2026-01-01", to: "2027-06-30" }), "week", "546 days");
  assert.equal(grainFor({ from: "2026-01-01", to: "2027-12-31" }), "week", "730 days");
  assert.equal(grainFor({ from: "2026-01-01", to: "2028-01-01" }), "month", "731 days");
});

test("day numbers that are counted are counted, not compared", () => {
  // istDayNumber is yyyymmdd -- right for sorting, wrong to subtract. A
  // year came out as "three years long" when it was subtracted.
  assert.equal(istDayNumber("2026-12-31") - istDayNumber("2026-01-01"), 1130);
  assert.equal(istDayIndex("2026-12-31") - istDayIndex("2026-01-01"), 364, "a real year");
  assert.equal(dayIndexToIso(istDayIndex("2026-06-15")), "2026-06-15", "and it round-trips");
});

test("every bucket in the period is drawn, including the empty ones", () => {
  // A chart that skips its empty days draws a straight line through a week
  // the shop was shut and reads as steady trade.
  const rows = documentsFor({
    invoices: [invoice({ date: "2026-06-03" })],
    side: "Sale",
    from: "2026-06-01",
    to: "2026-06-05",
  });
  const series = trendSeries({ rows, from: "2026-06-01", to: "2026-06-05", grain: "day" });
  assert.equal(series.length, 5, "five days, one of them with business in it");
  assert.deepEqual(series.map((b) => b.gross), [0, 0, 1500, 0, 0]);
  assert.deepEqual(series.map((b) => b.label), ["1 Jun", "2 Jun", "3 Jun", "4 Jun", "5 Jun"]);
});

test("a week bucket is seven days, anchored on its Monday", () => {
  // 1 June 2026 is a Monday.
  const rows = documentsFor({
    invoices: [
      invoice({ invoiceNo: 1, date: "2026-06-01" }),
      invoice({ invoiceNo: 2, date: "2026-06-07" }),
      invoice({ invoiceNo: 3, date: "2026-06-08" }),
    ],
    side: "Sale",
    from: "2026-06-01",
    to: "2026-06-14",
  });
  const series = trendSeries({ rows, from: "2026-06-01", to: "2026-06-14", grain: "week" });
  assert.equal(series.length, 2);
  assert.deepEqual(series.map((b) => b.key), ["W2026-06-01", "W2026-06-08"]);
  assert.deepEqual(series.map((b) => b.gross), [3000, 1500], "Mon-Sun, then the next week");
  assert.deepEqual(series.map((b) => b.label), ["1 Jun", "8 Jun"]);
});

test("the buckets run oldest first at every grain", () => {
  const rows = documentsFor({
    invoices: [
      invoice({ invoiceNo: 1, date: "2026-06-20" }),
      invoice({ invoiceNo: 2, date: "2026-04-02" }),
      invoice({ invoiceNo: 3, date: "2026-05-09" }),
    ],
    side: "Sale",
    from: "2026-04-01",
    to: "2026-06-30",
  });
  const months = trendSeries({ rows, from: "2026-04-01", to: "2026-06-30", grain: "month" });
  assert.deepEqual(months.map((b) => b.label), ["Apr 2026", "May 2026", "Jun 2026"]);
  assert.deepEqual(months.map((b) => b.gross), [1500, 1500, 1500]);
});

test("returns are their own bars, and the net is the difference", () => {
  const rows = documentsFor({
    invoices: [
      invoice({ invoiceNo: 1, date: "2026-06-03" }),
      invoice({ invoiceNo: 2, date: "2026-06-03", return: true, finalAmount: 400, totalAmount: 400, gst: 0 }),
    ],
    side: "Sale",
    from: "2026-06-01",
    to: "2026-06-05",
  });
  const day = trendSeries({ rows, from: "2026-06-01", to: "2026-06-05", grain: "day" })[2];
  assert.equal(day.gross, 1500);
  assert.equal(day.returns, 400);
  assert.equal(day.net, 1100);
  assert.equal(day.invoices, 1, "a credit note is not a bill");
  // And the chart's bars add up to the card above them.
  const series = trendSeries({ rows, from: "2026-06-01", to: "2026-06-05", grain: "day" });
  const m = trendMetrics(rows);
  assert.equal(series.reduce((t, b) => t + b.gross, 0), m.gross);
  assert.equal(series.reduce((t, b) => t + b.returns, 0), m.returns);
});

test("the series sorts itself, not only because the rows arrived sorted", () => {
  // With a period given, the empty buckets are laid out in order first and
  // the Map is already sorted -- which hides a missing sort. Without one, the
  // buckets arrive in row order, and the sort is the only thing fixing it.
  const rows = [
    { date: "2026-06-20", total: 300, isReturn: false },
    { date: "2026-04-02", total: 100, isReturn: false },
    { date: "2026-05-09", total: 200, isReturn: false },
  ];
  const series = trendSeries({ rows, grain: "month" });
  assert.deepEqual(series.map((b) => b.label), ["Apr 2026", "May 2026", "Jun 2026"]);
  assert.deepEqual(series.map((b) => b.gross), [100, 200, 300]);
});

test("a dateless row reaches no bar at all", () => {
  // documentsFor drops these upstream, so this goes straight at the series:
  // a bucket called "unknown" would draw a bar with no date under it.
  const series = trendSeries({
    rows: [
      { date: "2026-06-03", total: 500, isReturn: false },
      { date: null, total: 9999, isReturn: false },
    ],
    from: "2026-06-01",
    to: "2026-06-05",
    grain: "day",
  });
  assert.equal(series.length, 5, "five days, and no sixth bucket");
  assert.equal(series.reduce((t, b) => t + b.gross, 0), 500, "the dateless 9999 is out");
});

test("a dateless document reaches no bucket", () => {
  assert.equal(bucketOf({ date: null }, "day"), null);
  assert.equal(bucketOf({ date: "2026-06-15" }, "month"), "2026-06");
  assert.equal(bucketOf({ date: "2026-06-15" }, "day"), "2026-06-15");
  assert.equal(bucketLabel("2026-06", "month"), "Jun 2026");
  assert.equal(bucketLabel("nonsense", "day"), "nonsense");
});

console.log("\n--- receivables and payables ---");

test("which side a party is on comes from their group, not their balance", () => {
  // A customer in credit because they paid in advance is still a customer.
  // Classifying by sign would move them into the payables and overstate what
  // the firm owes.
  assert.equal(onSide(party({ lastBal: -5000 }), "receivable"), true);
  assert.equal(onSide(party({ lastBal: -5000 }), "payable"), false);
  // And the legacy spellings resolve onto the same groups.
  assert.equal(onSide(party({ group: "customer" }), "receivable"), true);
  assert.equal(onSide(party({ group: "supplier" }), "payable"), true);
  assert.equal(onSide(party({ group: "Cash" }), "receivable"), false);
  assert.equal(onSide(party({ group: "" }), "receivable"), false);
  assert.equal(isPartySide("receivable"), true);
  assert.equal(isPartySide("both"), false);
  assert.deepEqual(Object.keys(PARTY_SIDES), ["receivable", "payable"]);
});

test("a debit balance is a receivable, and a credit one is an advance", () => {
  const customers = [
    party({ _id: "a", name: "Owes Us", lastBal: 1500 }),
    party({ _id: "b", name: "Paid Ahead", lastBal: -800 }),
    party({ _id: "c", name: "Square", lastBal: 0 }),
  ];
  const { rows, advances } = partyRows({ customers, side: "receivable" });
  assert.deepEqual(rows.map((r) => r.name), ["Owes Us"]);
  assert.equal(rows[0].outstanding, 1500);
  assert.equal(rows[0].mode, "Dr");
  assert.equal(rows[0].id, "a", "so the row can reach its own ledger");
  // The advance is reported, and NOT added to the receivables.
  assert.deepEqual(advances.map((r) => r.name), ["Paid Ahead"]);
  assert.equal(advances[0].outstanding, 800, "a magnitude, with Cr beside it");
  assert.equal(advances[0].mode, "Cr");
  // A settled party is in neither.
  assert.equal(rows.concat(advances).some((r) => r.name === "Square"), false);
});

test("a credit balance is a payable, and a debit one is an advance paid", () => {
  const customers = [
    party({ _id: "s1", name: "We Owe", group: "Sundry Creditors", lastBal: -2000 }),
    party({ _id: "s2", name: "Prepaid", group: "Sundry Creditors", lastBal: 700 }),
  ];
  const { rows, advances } = partyRows({ customers, side: "payable" });
  assert.deepEqual(rows.map((r) => r.name), ["We Owe"]);
  assert.equal(rows[0].outstanding, 2000, "shown as a positive payable");
  assert.equal(rows[0].mode, "Cr");
  assert.deepEqual(advances.map((r) => r.name), ["Prepaid"]);
  assert.equal(advances[0].outstanding, 700);
});

test("a customer is never counted as a supplier, whichever way they lean", () => {
  const customers = [
    party({ name: "Cust Dr", lastBal: 1000 }),
    party({ name: "Cust Cr", lastBal: -1000 }),
    party({ name: "Supp Cr", group: "Sundry Creditors", lastBal: -3000 }),
    party({ name: "Supp Dr", group: "Sundry Creditors", lastBal: 400 }),
  ];
  const receivable = partyRows({ customers, side: "receivable" });
  const payable = partyRows({ customers, side: "payable" });
  assert.deepEqual(receivable.rows.map((r) => r.name), ["Cust Dr"]);
  assert.deepEqual(payable.rows.map((r) => r.name), ["Supp Cr"]);
  // No party appears on both sides.
  const all = [...receivable.rows, ...receivable.advances, ...payable.rows, ...payable.advances];
  assert.equal(new Set(all.map((r) => r.name)).size, all.length);
});

test("the card is the sum of the rows under it, by construction", () => {
  const customers = [
    party({ name: "A", lastBal: 1500 }),
    party({ name: "B", lastBal: 2500.55 }),
    party({ name: "C", lastBal: -300 }),
  ];
  const sides = partyRows({ customers, side: "receivable" });
  const summary = partySummary({ ...sides, collected: 900 });
  assert.equal(summary.total, 4000.55);
  assert.equal(summary.total, sides.rows.reduce((t, r) => t + r.outstanding, 0));
  assert.equal(summary.parties, 2);
  assert.equal(summary.advances, 300);
  assert.equal(summary.advanceParties, 1);
  assert.equal(summary.collected, 900);
});

test("an unknown side returns nothing rather than everything", () => {
  const customers = [party({ name: "A", lastBal: 1000 })];
  assert.deepEqual(partyRows({ customers, side: "nonsense" }), { rows: [], advances: [] });
  assert.deepEqual(partyRows({ customers, side: "" }), { rows: [], advances: [] });
  assert.deepEqual(partyRows({}), { rows: [], advances: [] });
});

test("a figure that could not be derived is null, not zero", () => {
  // Zero reads as "nothing came in". Null reads as "we do not know", which
  // is the truth when the vouchers were not available.
  const summary = partySummary({ rows: [], advances: [] });
  assert.equal(summary.collected, null);
  assert.equal(partySummary({ rows: [], advances: [], collected: 0 }).collected, 0, "and a real zero stays zero");
  assert.equal(partySummary({ rows: [], advances: [], collected: 125.5 }).collected, 125.5);
});

test("nothing is reported overdue, because no due date exists", () => {
  const summary = partySummary({ rows: [party()], advances: [] });
  assert.equal(summary.overdue, null, "not 0, which would read as 'none overdue'");
  assert.equal(summary.overdueNote, OVERDUE_UNAVAILABLE);
  assert.match(OVERDUE_UNAVAILABLE, /No due date is recorded/);
  // And the module does not age from the invoice date and call it a due date.
  const src = code(read("../lib/dashboard.mjs"));
  assert.doesNotMatch(src, /dueDate|creditDays|overdueDays/);
});

test("the biggest debt is first, and the table can be searched and paged", () => {
  // The names are deliberately NOT in the same order as the amounts: an
  // earlier fixture had Big/Middling/Small, which is both orders at once, so
  // sorting by name and not sorting at all looked identical.
  const customers = [
    party({ name: "Zebra Steel", city: "Agra", lastBal: 9000 }),
    party({ name: "Apex Metals", city: "Delhi", lastBal: 100 }),
    party({ name: "Middle Works", city: "Delhi", lastBal: 500 }),
  ];
  const { rows } = partyRows({ customers, side: "receivable" });
  assert.deepEqual(rows.map((r) => r.name), ["Zebra Steel", "Middle Works", "Apex Metals"]);
  assert.deepEqual(
    filterParties({ rows, sort: "name" }).map((r) => r.name),
    ["Apex Metals", "Middle Works", "Zebra Steel"],
    "by name, which is not the order by amount"
  );
  assert.deepEqual(
    filterParties({ rows, search: "delhi" }).map((r) => r.name),
    ["Middle Works", "Apex Metals"],
    "by city"
  );
  assert.deepEqual(filterParties({ rows, search: "zeb" }).map((r) => r.name), ["Zebra Steel"]);
  assert.deepEqual(filterParties({ rows, search: "nobody" }), []);

  const page1 = paginate(rows, 1, 2);
  assert.deepEqual([page1.page, page1.pages, page1.total, page1.rows.length], [1, 2, 3, 2]);
  assert.deepEqual(page1.rows.map((r) => r.name), ["Zebra Steel", "Middle Works"]);
  const page2 = paginate(rows, 2, 2);
  assert.deepEqual(page2.rows.map((r) => r.name), ["Apex Metals"]);
  // A page past the end lands on the last one rather than showing nothing.
  assert.equal(paginate(rows, 99, 2).page, 2);
  assert.equal(paginate([], 1, 20).pages, 1);
});

console.log("\n--- money that moved, as against money invoiced ---");

test("receipts come off the vouchers, not off the invoices", () => {
  // Summing the Ledger would count a credit sale as money received: invoice
  // postings and voucher postings both write Ledger rows.
  const vouchers = [
    { date: "2026-06-05", acName: "Cash", customers: [{ name: "Acme Traders", debit: 0, credit: 900 }] },
    { date: "2026-06-20", acName: "Cash", customers: [{ name: "Acme Traders", debit: 0, credit: 500 }] },
  ];
  const names = new Set(["Acme Traders"]);
  const inJune = vouchersIn({ vouchers, from: "2026-06-01", to: "2026-06-10" });
  assert.equal(inJune.length, 1, "the period cuts the vouchers too");
  assert.equal(movedInPeriod({ vouchers: inJune, parties: names, side: "receivable" }), 900);
  assert.equal(
    movedInPeriod({ vouchers, parties: names, side: "receivable" }),
    1400,
    "both, over the wider window"
  );
  // The reason is recorded in the module, in a comment that wraps -- so the
  // grep is for the sentence's substance rather than one line of it.
  const whole = read("../lib/dashboard.mjs");
  assert.match(whole, /postings both write Ledger rows/, "the reason must be recorded");
  const src = code(whole);
  assert.doesNotMatch(src, /models\/ledgerModel|Ledger\.find|Ledger\.aggregate/,
    "it must not read the ledger collection");
});

test("a receipt credits a customer and a payment debits a supplier", () => {
  const vouchers = [
    {
      date: "2026-06-05",
      customers: [
        { name: "Acme Traders", debit: 0, credit: 900 },
        { name: "Steel Supply", debit: 700, credit: 0 },
      ],
    },
  ];
  assert.equal(
    movedInPeriod({ vouchers, parties: new Set(["Acme Traders"]), side: "receivable" }),
    900
  );
  assert.equal(
    movedInPeriod({ vouchers, parties: new Set(["Steel Supply"]), side: "payable" }),
    700
  );
  // A customer's debit is not a receipt, and a supplier's credit is not a
  // payment -- those are the other direction entirely.
  assert.equal(
    movedInPeriod({ vouchers, parties: new Set(["Steel Supply"]), side: "receivable" }),
    0
  );
  // A party not on the chosen side contributes nothing.
  assert.equal(movedInPeriod({ vouchers, parties: new Set(["Nobody"]), side: "receivable" }), 0);
});

test("a dateless voucher is in no period", () => {
  const vouchers = [{ date: null, customers: [{ name: "A", credit: 100 }] }];
  assert.deepEqual(vouchersIn({ vouchers, from: "2026-06-01", to: "2026-06-30" }), []);
  // And with no window given, everything dated is in.
  assert.equal(vouchersIn({ vouchers: [{ date: "2026-06-05" }] }).length, 1);
});

console.log("\n--- low stock ---");

test("the stock figure is the ledger's, not the item master's", () => {
  // `Item.lastQuantity` is typed in by hand and nothing in the posting path
  // writes it. buildStockIndex sums the movements instead.
  const items = [{ name: "Plate", openingQuantity: 10, unit: "KGS", lastQuantity: 999 }];
  const movements = [{ _id: "Plate", received: 5, issued: 12 }];
  const stock = buildStockIndex({ items, movements });
  assert.equal(stock[0].quantity, 3, "10 opening + 5 in - 12 out");
  const src = code(read("../lib/dashboard.mjs"));
  assert.doesNotMatch(src, /lastQuantity/, "the stale field must not be read");
  assert.ok(/buildStockIndex/.test(read("../app/api/analytics/route.js")));
});

test("an item with no minimum is not compared against an invented one", () => {
  assert.equal(stockReason(5, null), null, "no threshold, no 'below minimum'");
  assert.equal(stockReason(5, undefined), null);
  assert.equal(stockReason(5, 0), null, "a zero minimum is not a minimum");
  assert.equal(stockReason(5, 10), "below");
  assert.equal(stockReason(10, 10), null, "at the minimum is not below it");
  // Out and negative need no threshold to be worth knowing.
  assert.equal(stockReason(0, null), "out");
  assert.equal(stockReason(-3, null), "negative");
  assert.equal(stockReason(-3, 10), "negative", "negative outranks below");
});

test("the re-order level fires after the minimum, and the maximum last", () => {
  // Sigfa's own warning prints both levels, with the re-order level ABOVE the
  // minimum -- you order again before you reach the floor. So an item below
  // both is reported as below its MINIMUM, which is the more urgent of the
  // two, and one below only the re-order level says so.
  const levels = { minimum: 25, reorder: 60, maximum: 500 };
  assert.equal(stockReason(20, levels), "below");
  assert.equal(stockReason(40, levels), "reorder");
  // Exactly AT a level is not past it, for all three -- the same rule the
  // minimum has always had, so the three cannot drift apart.
  assert.equal(stockReason(60, levels), null, "at the re-order level is not below it");
  assert.equal(stockReason(100, levels), null);
  assert.equal(stockReason(600, levels), "over");
  assert.equal(stockReason(500, levels), null, "at the maximum is not over it");
  // Each one is optional on its own.
  assert.equal(stockReason(40, { reorder: 60 }), "reorder");
  assert.equal(stockReason(600, { maximum: 500 }), "over");
  assert.equal(stockReason(600, { maximum: 0 }), null, "a zero maximum is not a maximum");
  assert.equal(stockReason(40, {}), null);
  // And the bare number still means the minimum, which is all this rule knew
  // before the other two levels existed.
  assert.equal(stockReason(5, 10), "below");
});

test("the alerts run most urgent first and carry the shortfall", () => {
  const items = [
    { _id: "i1", name: "Plate", unit: "KGS", hsn: "7308", openingQuantity: 0, minQuantity: 10 },
    { _id: "i2", name: "Washer", unit: "NOS", openingQuantity: 0, minQuantity: 100 },
    { _id: "i3", name: "Pipe", unit: "MTR", openingQuantity: 0 },
    { _id: "i4", name: "Plenty", unit: "NOS", openingQuantity: 0, minQuantity: 5 },
  ];
  const stock = buildStockIndex({
    items,
    movements: [
      { _id: "Plate", received: 4, issued: 0 },
      { _id: "Washer", received: 0, issued: 7 },
      { _id: "Pipe", received: 0, issued: 0 },
      { _id: "Plenty", received: 50, issued: 0 },
    ],
  });
  const rows = lowStockRows({ stock, items });
  // Negative, then out, then below.
  assert.deepEqual(rows.map((r) => r.name), ["Washer", "Pipe", "Plate"]);
  assert.deepEqual(rows.map((r) => r.reason), ["negative", "out", "below"]);
  assert.equal(rows.find((r) => r.name === "Plate").shortfall, 6, "10 wanted, 4 on hand");
  assert.equal(rows.find((r) => r.name === "Pipe").shortfall, null, "no minimum, no shortfall");
  assert.equal(rows.find((r) => r.name === "Plate").id, "i1", "so the row can reach its ledger");
  assert.equal(rows.find((r) => r.name === "Plate").unit, "KGS");
  assert.equal(rows.find((r) => r.name === "Plate").hsn, "7308");
  // The well-stocked item is not an alert at all.
  assert.equal(rows.some((r) => r.name === "Plenty"), false);
  // Five reasons now -- the re-order level and the maximum came with Sigfa's
  // Under-Over Stock report (lib/inventory.mjs). The TILE still shows three.
  assert.deepEqual(Object.keys(STOCK_REASON_LABELS), [
    "negative", "out", "below", "reorder", "over",
  ]);
  assert.deepEqual(DASHBOARD_REASONS, ["negative", "out", "below"]);
});

test("the dashboard tile does not fill up with planning thresholds", () => {
  // An item between its re-order level and its maximum is a purchasing
  // question, not an alert, and a tile headed low stock that fired on it
  // would be permanently full. The Short List asks for all five.
  const items = [
    { _id: "i1", name: "Plate", openingQuantity: 40, minQuantity: 25, reorderLevel: 60, maxLevel: 500 },
    { _id: "i2", name: "Pipe", openingQuantity: 900, minQuantity: 10, maxLevel: 500 },
  ];
  const stock = buildStockIndex({ items, movements: [] });
  assert.deepEqual(lowStockRows({ stock, items }), [], "neither belongs on the tile");

  const all = lowStockRows({ stock, items, reasons: STOCK_REASONS });
  assert.deepEqual(all.map((r) => [r.name, r.reason]), [["Plate", "reorder"], ["Pipe", "over"]]);
  // Required is measured against the level that FIRED, not against the
  // minimum it is still above.
  assert.equal(all[0].shortfall, 20, "60 wanted, 40 on hand");
  assert.equal(all[0].excess, null);
  assert.equal(all[1].shortfall, null, "nothing is required when there is too much");
  assert.equal(all[1].excess, 400, "900 on hand against a maximum of 500");
});

test("the stock cards say how much of the master has a minimum at all", () => {
  const items = [
    { name: "A", openingQuantity: 0, minQuantity: 10 },
    { name: "B", openingQuantity: 5 },
    { name: "C", openingQuantity: 0 },
  ];
  const stock = buildStockIndex({ items, movements: [] });
  const rows = lowStockRows({ stock, items });
  const summary = stockSummary({ rows, stock, items });
  assert.equal(summary.alerts, 2, "A and C are out of stock");
  assert.equal(summary.out, 2);
  assert.equal(summary.negative, 0);
  assert.equal(summary.below, 0);
  assert.equal(summary.items, 3);
  // So the screen can say the alert list is not the whole picture.
  assert.equal(summary.withMinimum, 1);
  assert.equal(summary.withoutMinimum, 2);
});

test("a movement for an item no longer in the master is still reported", () => {
  const stock = buildStockIndex({ items: [], movements: [{ _id: "Ghost", received: 0, issued: 4 }] });
  const rows = lowStockRows({ stock, items: [] });
  assert.deepEqual(rows.map((r) => [r.name, r.reason]), [["Ghost", "negative"]]);
  assert.equal(rows[0].id, "", "nothing to link to, and the screen shows no link");
});

console.log("\n--- the comparison table ---");

test("every metric says which measure it is", () => {
  assert.deepEqual(COMPARISON_METRICS.map((m) => m.key), [
    "grossSales", "salesReturns", "netSales",
    "grossPurchases", "purchaseReturns", "netPurchases",
    "receipts", "payments",
  ]);
  for (const metric of COMPARISON_METRICS) {
    assert.ok(metric.label && metric.measure, metric.key);
  }
  // An invoice total and money received are different things, and the table
  // says so rather than putting them in one column of numbers.
  assert.match(COMPARISON_METRICS.find((m) => m.key === "grossSales").measure, /Invoiced/);
  assert.match(COMPARISON_METRICS.find((m) => m.key === "receipts").measure, /actually received/);
});

test("balances are deliberately absent from the comparison", () => {
  // There is no "last month's receivables" without replaying every posting
  // to the end of last month, and this app stores no dated balance.
  assert.equal(COMPARISON_METRICS.some((m) => /receivab|payab/i.test(m.key)), false);
  assert.deepEqual(POINT_IN_TIME, ["receivables", "payables", "stock"]);
});

test("the comparison rows carry both periods and the change", () => {
  const rows = comparisonRows({
    current: { grossSales: 1000, salesReturns: 0, receipts: 400 },
    previous: { grossSales: 800, salesReturns: 50, receipts: 0 },
  });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(
    [by.grossSales.current, by.grossSales.previous, by.grossSales.diff, by.grossSales.pct],
    [1000, 800, 200, 25]
  );
  assert.equal(by.salesReturns.direction, "down");
  assert.equal(by.receipts.direction, "new", "nothing came in last period");
  assert.equal(by.receipts.pct, null);
  // A metric neither period mentions is zero on both sides, not missing.
  assert.equal(by.netPurchases.current, 0);
  assert.equal(by.netPurchases.direction, "same");
  assert.equal(rows.length, COMPARISON_METRICS.length);
});

test("each figure comes off its own side and its own column", () => {
  // Every amount here is different, so a sale read as a purchase, or a
  // receipt read as a payment, cannot come out right by accident.
  const invoices = [
    invoice({ invoiceNo: 1, finalAmount: 1000 }),
    invoice({ invoiceNo: 2, type: "Purchase", finalAmount: 2000 }),
    invoice({ invoiceNo: 3, return: true, finalAmount: 100 }),
    invoice({ invoiceNo: 4, type: "Purchase", return: true, finalAmount: 200 }),
  ];
  const vouchers = [
    {
      date: "2026-06-12",
      customers: [
        { name: "Acme Traders", debit: 0, credit: 400 },
        { name: "Steel Supply", debit: 700, credit: 0 },
      ],
    },
  ];
  const figures = periodFigures({
    invoices,
    vouchers,
    customerNames: new Set(["Acme Traders"]),
    supplierNames: new Set(["Steel Supply"]),
    from: "2026-06-01",
    to: "2026-06-30",
  });

  assert.equal(figures.grossSales, 1000);
  assert.equal(figures.grossPurchases, 2000);
  assert.equal(figures.salesReturns, 100);
  assert.equal(figures.purchaseReturns, 200);
  assert.equal(figures.netSales, 900);
  assert.equal(figures.netPurchases, 1800);
  assert.equal(figures.receipts, 400, "the customer's credit");
  assert.equal(figures.payments, 700, "the supplier's debit");
});

test("the two periods' figures are built the same way", () => {
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-10" }),
    invoice({ invoiceNo: 2, date: "2026-05-10" }),
    invoice({ invoiceNo: 3, date: "2026-05-11", return: true, finalAmount: 300, totalAmount: 300, gst: 0 }),
  ];
  const june = periodFigures({ invoices, from: "2026-06-01", to: "2026-06-30" });
  const may = periodFigures({ invoices, from: "2026-05-01", to: "2026-05-31" });
  assert.equal(june.grossSales, 1500);
  assert.equal(june.salesReturns, 0);
  assert.equal(may.grossSales, 1500);
  assert.equal(may.salesReturns, 300);
  assert.equal(may.netSales, 1200);
  // And one period's documents never leak into the other's.
  assert.equal(june.netSales, 1500);
});

console.log("\n--- the wiring ---");

test("one route serves the dashboard, wrapped and validated", () => {
  const src = read("../app/api/analytics/route.js");
  assert.ok(/export const GET = tenantRoute\(/.test(src));
  assert.doesNotMatch(src, /^export\s+async\s+function\s+GET\b/m, "it must be wrapped");
  // Every parameter checked on the server, not only in the form.
  for (const guard of ["isPreset", "isPartySide", "periodProblem"]) {
    assert.ok(src.includes(guard), `${guard} is not checked`);
  }
});

test("the route computes nothing itself", () => {
  const src = code(read("../app/api/analytics/route.js"));
  for (const fn of [
    "trendMetrics", "trendSeries", "partyRows", "partySummary",
    // `alertConditions` is lowStockRows less services (lib/stockAlerts.mjs),
    // so the low-stock rule is still the module's, not the route's.
    "alertConditions", "stockSummary", "comparisonRows", "periodFigures", "vouchersIn",
  ]) {
    assert.ok(src.includes(fn), `${fn} is not used`);
  }
  assert.doesNotMatch(src, /\.reduce\(/, "the route is doing its own totalling");
});

test("the route aggregates the stock ledger in the database", () => {
  // It is the biggest collection in the app. A scan per item would be an
  // N+1 over the whole master.
  const src = read("../app/api/analytics/route.js");
  assert.ok(/ItemLedger\.aggregate\(/.test(src));
  assert.ok(/\$sum: "\$receiptQuantity"/.test(src));
  assert.equal((src.match(/ItemLedger\./g) || []).length, 1, "exactly one stock query");
  // And the invoice lines are not fetched at all -- no figure here reads one.
  assert.doesNotMatch(code(src), /items: 1/, "the lines are the bulk of an invoice");
});

test("the route fetches one window for both periods, widened for IST", () => {
  const src = read("../app/api/analytics/route.js");
  assert.ok(/windowStart\.setUTCDate\(windowStart\.getUTCDate\(\) - 1\)/.test(src));
  assert.ok(/windowEnd\.setUTCDate\(windowEnd\.getUTCDate\(\) \+ 2\)/.test(src));
  // One query each, not one per section.
  assert.equal((src.match(/Invoice\.find\(/g) || []).length, 1);
  assert.equal((src.match(/Voucher\.find\(/g) || []).length, 1);
  assert.equal((src.match(/Customer\.find\(/g) || []).length, 1);
  assert.ok(/Promise\.all\(\[/.test(src), "and they go out together");
});

test("the route returns only what the screen shows of a party", () => {
  const src = read("../app/api/analytics/route.js");
  // No phone book, no credentials, no user records.
  assert.doesNotMatch(src, /models\/userModel|passwordHash|einvoicePassword/);
  assert.ok(/name: 1, group: 1, city: 1, phone: 1, lastBal: 1/.test(src), "projected by name");
});

test("the dashboard is owner and accountant, not biller", () => {
  for (const path of ["/dashboard", "/api/analytics"]) {
    assert.equal(permissionForPath(path), "report:read", path);
    assert.equal(canAccessPath("owner", path), true, path);
    assert.equal(canAccessPath("accountant", path), true, path);
    assert.equal(canAccessPath("biller", path), false, path);
  }
});

test("the page computes nothing and reaches the dashboard", () => {
  const page = read("../app/dashboard/page.js");
  assert.ok(/from '@\/lib\/dashboard\.mjs'/.test(page));
  assert.ok(/'\/dashboard'/.test(read("../app/page.js")), "no tile on the dashboard");
  // The only reduces on the page are over the series the module built, for
  // the chart's own scale -- never a money total.
  assert.doesNotMatch(code(page), /reduce\(\(t, r\) =>/, "the page is totalling money");
});

test("the page says what the date filter does and does not move", () => {
  const page = read("../app/dashboard/page.js");
  assert.ok(/a balance has no period/i.test(page));
  assert.ok(/As at today/.test(page), "the point-in-time sections must be labelled");
  // And that sales are not profit.
  assert.ok(/None of these is profit/i.test(page));
  assert.ok(/include GST/i.test(page), "the figures must say whether they do");
});

test("the page adds no charting dependency", () => {
  const pkg = JSON.parse(read("../package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const lib of ["recharts", "chart.js", "d3", "victory", "@nivo/core", "@visx/visx"]) {
    assert.equal(lib in deps, false, `${lib} was added`);
  }
  assert.ok(/<svg/.test(read("../app/dashboard/page.js")), "the chart is drawn here");
});

test("the item master carries an optional minimum, defaulted to nothing", () => {
  const model = read("../models/itemModel.js");
  assert.ok(/minQuantity:\{\n\s*type:Number\n\s*\},/.test(model), "declared, or strict mode drops it");
  // NO default. An item that has never had one set must not be compared
  // against an invented number.
  assert.doesNotMatch(model, /minQuantity:\{[^}]*default/s);
  // And it survives a save through both routes and the form.
  assert.ok(/minQuantity:itemData\.minBal/.test(read("../app/api/item-add/route.js")));
  assert.ok(/minQuantity: itemData\.minBal/.test(read("../app/api/item-alter/route.js")));
  const form = read("../app/itemadd/page.js");
  assert.ok(/minBal: numOrNull\(minBal\)/.test(form), "the form must send it");
  assert.ok(/setMinBal\(data\.minQuantity/.test(form), "and read it back on an edit");
});

test("the module defers to the sources that already own each figure", () => {
  const src = read("../lib/dashboard.mjs");
  for (const dep of ["salesReports.mjs", "accountGroups.mjs", "istDate.mjs", "balance.mjs"]) {
    assert.ok(src.includes(dep), `${dep} is not used`);
  }
  // It must not post, price or value anything of its own.
  assert.doesNotMatch(code(src), /invoiceDelta|voucherDelta|stockValue|splitGst/);
});

test("the module stays pure", () => {
  const src = read("../lib/dashboard.mjs");
  assert.doesNotMatch(src, /from\s+["']react["']/);
  assert.doesNotMatch(src, /from\s+["']mongoose["']/);
  assert.doesNotMatch(src, /from\s+["'][^"']*models\//);
});

console.log(`\n  ${passed} checks passed\n`);
