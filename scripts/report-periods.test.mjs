/**
 * Fixture tests for the shared report date filter.
 *
 *   node scripts/report-periods.test.mjs
 *
 * A date filter looks like the least interesting part of a reporting feature
 * and is where the figures actually go wrong, in four ways that all fail
 * silently:
 *
 *   1. THE TIMEZONE. Every date in this app is an IST calendar day. The
 *      container runs Asia/Calcutta and Vercel runs UTC, so a preset resolved
 *      from the server's clock gives a different month on the 1st, between
 *      midnight and 5:30am. `app/account-book/page.js` had exactly this bug
 *      in its own default dates -- `new Date().toISOString()` for "today" --
 *      and it is the reason there is now one resolver instead of five.
 *
 *   2. THE FINANCIAL YEAR. 1 April to 31 March. A calendar year would be
 *      wrong for every user of this app, and a January date belongs to the
 *      year that STARTED the previous April, which is the off-by-one that
 *      makes a whole quarter land in the wrong return.
 *
 *   3. INCLUSIVITY. Both ends. "1 to 30 April" includes everything dated the
 *      30th. An exclusive end drops the last day of every month, which is
 *      precisely the day a shop raises the most bills.
 *
 *   4. THE QUERY WINDOW. Widened by a day at each edge, with the exact cut
 *      left to the pure module. Narrowing it to the exact instants drops an
 *      invoice saved at 11pm IST on the last day of the range -- it is stored
 *      as 17:30 UTC, outside a UTC-midnight boundary.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ALL_PRESETS,
  FY_START_MONTH,
  PRESET_GROUPS,
  PRESET_LABELS,
  WEEK_START,
  fyLabel,
  fyQuarter,
  fyStart,
  isPreset,
  istIso,
  lastDayOf,
  periodDays,
  periodProblem,
  periodText,
  queryWindow,
  resolvePeriod,
  samePeriod,
  shiftDays,
} from "../lib/reportPeriods.mjs";

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

// Monday 12 October 2026, 11:30 IST. Deliberately a Monday, so the week
// presets are checked on the boundary rather than in the middle.
const NOW = Date.parse("2026-10-12T06:00:00Z");
const at = (preset, extra) => resolvePeriod({ preset, now: NOW, ...extra });

console.log("\n--- the presets ---");

test("all thirteen the brief asks for are offered, and grouped", () => {
  assert.equal(ALL_PRESETS.length, 13);
  assert.deepEqual(ALL_PRESETS, [
    "today",
    "yesterday",
    "last7",
    "last30",
    "thisWeek",
    "prevWeek",
    "thisMonth",
    "prevMonth",
    "thisQuarter",
    "prevQuarter",
    "thisFy",
    "prevFy",
    "custom",
  ]);
  // Every grouped key is a real preset and every preset is in a group, so a
  // picker built from PRESET_GROUPS cannot be missing one.
  assert.deepEqual([...PRESET_GROUPS.flatMap((g) => g.keys)].sort(), [...ALL_PRESETS].sort());
});

test("every preset has a label", () => {
  for (const key of ALL_PRESETS) {
    assert.equal(typeof PRESET_LABELS[key], "string", key);
    assert.ok(PRESET_LABELS[key].length > 2, key);
  }
});

test("only a real preset is a preset", () => {
  assert.equal(isPreset("thisQuarter"), true);
  assert.equal(isPreset("nextQuarter"), false);
  assert.equal(isPreset(""), false);
  assert.equal(isPreset(null), false);
});

console.log("\n--- days ---");

test("today and yesterday are one day each", () => {
  assert.deepEqual([at("today").from, at("today").to], ["2026-10-12", "2026-10-12"]);
  assert.deepEqual([at("yesterday").from, at("yesterday").to], ["2026-10-11", "2026-10-11"]);
  assert.equal(periodDays(at("today")), 1);
  assert.equal(periodDays(at("yesterday")), 1);
});

test("last 7 days is seven days of books, not eight", () => {
  const p = at("last7");
  assert.deepEqual([p.from, p.to], ["2026-10-06", "2026-10-12"]);
  assert.equal(periodDays(p), 7);
  assert.equal(periodDays(at("last30")), 30);
});

console.log("\n--- weeks (Monday start) ---");

test("a week starts on Monday", () => {
  assert.equal(WEEK_START, 1);
  // The 12th IS a Monday, so this week starts on it.
  assert.deepEqual([at("thisWeek").from, at("thisWeek").to], ["2026-10-12", "2026-10-18"]);
  assert.deepEqual([at("prevWeek").from, at("prevWeek").to], ["2026-10-05", "2026-10-11"]);
});

test("Sunday belongs to the week that began the previous Monday", () => {
  // Sunday 18 October 2026. The trap: a naive (day % 7) puts Sunday at the
  // START of the coming week, so a shop checking Sunday evening's takings
  // sees an empty sheet.
  const sunday = Date.parse("2026-10-18T06:00:00Z");
  const p = resolvePeriod({ preset: "thisWeek", now: sunday });
  assert.deepEqual([p.from, p.to], ["2026-10-12", "2026-10-18"]);
  const prev = resolvePeriod({ preset: "prevWeek", now: sunday });
  assert.deepEqual([prev.from, prev.to], ["2026-10-05", "2026-10-11"]);
});

test("a week carries across a month end", () => {
  // Wednesday 1 April 2026 -- the week began in March.
  const p = resolvePeriod({ preset: "thisWeek", now: Date.parse("2026-04-01T06:00:00Z") });
  assert.deepEqual([p.from, p.to], ["2026-03-30", "2026-04-05"]);
  assert.equal(periodDays(p), 7);
});

console.log("\n--- months ---");

test("a month runs to its own last day, February included", () => {
  assert.deepEqual([at("thisMonth").from, at("thisMonth").to], ["2026-10-01", "2026-10-31"]);
  const feb = resolvePeriod({ preset: "thisMonth", now: Date.parse("2028-02-10T06:00:00Z") });
  // 2028 is a leap year; 29 days, not 28 and not 30.
  assert.equal(feb.to, "2028-02-29");
  assert.equal(lastDayOf(2026, 2), 28);
  assert.equal(lastDayOf(2028, 2), 29);
});

test("the previous month of January is December of the year before", () => {
  const jan = Date.parse("2027-01-20T06:00:00Z");
  const p = resolvePeriod({ preset: "prevMonth", now: jan });
  assert.deepEqual([p.from, p.to], ["2026-12-01", "2026-12-31"]);
  assert.equal(p.label, "Dec 2026");
});

console.log("\n--- quarters are FINANCIAL quarters ---");

test("April opens Q1 and January is Q4 of the year that began in April", () => {
  assert.equal(FY_START_MONTH, 4);
  assert.equal(fyQuarter({ year: 2026, month: 4 }), 1);
  assert.equal(fyQuarter({ year: 2026, month: 6 }), 1);
  assert.equal(fyQuarter({ year: 2026, month: 7 }), 2);
  assert.equal(fyQuarter({ year: 2026, month: 10 }), 3);
  assert.equal(fyQuarter({ year: 2027, month: 1 }), 4);
  assert.equal(fyQuarter({ year: 2027, month: 3 }), 4);
});

test("this quarter is three whole months of the financial year", () => {
  const p = at("thisQuarter");
  assert.deepEqual([p.from, p.to], ["2026-10-01", "2026-12-31"]);
  assert.equal(p.label, "Q3 FY 2026-27");
});

test("Q4 crosses the calendar year without changing financial year", () => {
  const jan = Date.parse("2027-01-20T06:00:00Z");
  const p = resolvePeriod({ preset: "thisQuarter", now: jan });
  assert.deepEqual([p.from, p.to], ["2027-01-01", "2027-03-31"]);
  assert.equal(p.label, "Q4 FY 2026-27");
});

test("the quarter before Q1 is Q4 of the previous financial year", () => {
  const may = Date.parse("2026-05-10T06:00:00Z");
  assert.equal(resolvePeriod({ preset: "thisQuarter", now: may }).label, "Q1 FY 2026-27");
  const prev = resolvePeriod({ preset: "prevQuarter", now: may });
  assert.deepEqual([prev.from, prev.to], ["2026-01-01", "2026-03-31"]);
  assert.equal(prev.label, "Q4 FY 2025-26");
});

test("the quarter before Q4 is Q3, in the calendar year before it", () => {
  const jan = Date.parse("2027-02-20T06:00:00Z");
  const prev = resolvePeriod({ preset: "prevQuarter", now: jan });
  assert.deepEqual([prev.from, prev.to], ["2026-10-01", "2026-12-31"]);
});

console.log("\n--- the financial year ---");

test("it runs 1 April to 31 March", () => {
  const p = at("thisFy");
  assert.deepEqual([p.from, p.to], ["2026-04-01", "2027-03-31"]);
  assert.equal(p.label, "FY 2026-27");
});

test("a January date belongs to the year that started the previous April", () => {
  assert.equal(fyStart({ year: 2026, month: 3 }), 2025);
  assert.equal(fyStart({ year: 2026, month: 4 }), 2026);
  const jan = Date.parse("2027-01-20T06:00:00Z");
  assert.deepEqual(
    [resolvePeriod({ preset: "thisFy", now: jan }).from, resolvePeriod({ preset: "thisFy", now: jan }).to],
    ["2026-04-01", "2027-03-31"]
  );
});

test("the previous financial year is the whole one before", () => {
  const p = at("prevFy");
  assert.deepEqual([p.from, p.to], ["2025-04-01", "2026-03-31"]);
  assert.equal(p.label, "FY 2025-26");
  assert.equal(fyLabel(2025), "FY 2025-26");
  // 1 April to 31 March is 365 days in a non-leap FY.
  assert.equal(periodDays(p), 365);
});

test("31 March and 1 April land on opposite sides of the boundary", () => {
  const mar31 = Date.parse("2027-03-31T06:00:00Z");
  const apr1 = Date.parse("2027-04-01T06:00:00Z");
  assert.equal(resolvePeriod({ preset: "thisFy", now: mar31 }).label, "FY 2026-27");
  assert.equal(resolvePeriod({ preset: "thisFy", now: apr1 }).label, "FY 2027-28");
});

console.log("\n--- the timezone ---");

test("a preset is resolved from the IST day, not the server's", () => {
  // 31 March 2027, 20:00 UTC = 1 April 2027, 01:30 IST. The financial year
  // has turned over in India and not in UTC. A server resolving this from
  // its own clock opens the book on the old year -- which is the bug the two
  // helpers deleted from app/account-book/page.js had.
  const lateUtc = Date.parse("2027-03-31T20:00:00Z");
  assert.equal(istIso(lateUtc), "2027-04-01");
  assert.equal(resolvePeriod({ preset: "thisFy", now: lateUtc }).label, "FY 2027-28");
  assert.equal(resolvePeriod({ preset: "today", now: lateUtc }).from, "2027-04-01");
});

test("and before 5:30am IST, 'today' is not the UTC date", () => {
  // 12 October 2026, 00:30 IST = 11 October, 19:00 UTC.
  const earlyIst = Date.parse("2026-10-11T19:00:00Z");
  assert.equal(istIso(earlyIst), "2026-10-12");
  assert.equal(resolvePeriod({ preset: "today", now: earlyIst }).from, "2026-10-12");
  // And nothing is not a date. Returning an epoch here would make an absent
  // value print as 1 January 1970 on a sheet rather than as blank.
  assert.equal(istIso(null), "");
  assert.equal(istIso(""), "");
  assert.equal(istIso("not a date"), "");
});

test("shifting days carries across months and years", () => {
  assert.equal(shiftDays("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDays("2028-03-01", -1), "2028-02-29");
  assert.equal(shiftDays("2027-01-01", -1), "2026-12-31");
  assert.equal(shiftDays("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDays("nonsense", 1), "");
});

console.log("\n--- custom ranges and validation ---");

test("custom keeps the dates it is given, and nothing else", () => {
  const p = at("custom", { from: "2026-02-03", to: "2026-02-09" });
  assert.deepEqual([p.preset, p.from, p.to], ["custom", "2026-02-03", "2026-02-09"]);
  // Without dates it is empty rather than silently today -- the caller's
  // validation then refuses it, which is the honest outcome.
  const blank = at("custom");
  assert.deepEqual([blank.from, blank.to], ["", ""]);
});

test("an unknown preset falls back to this month rather than throwing", () => {
  // Read off a query string a stale bookmark can hold. A 500 here would mean
  // an old link breaks the page; the ROUTE refuses an unknown preset
  // separately, with isPreset.
  const p = at("lastDecade");
  assert.equal(p.preset, "thisMonth");
  assert.deepEqual([p.from, p.to], ["2026-10-01", "2026-10-31"]);
});

test("a backwards or unparseable range is refused", () => {
  assert.equal(periodProblem({ from: "2026-06-01", to: "2026-06-30" }), null);
  assert.match(periodProblem({ from: "", to: "2026-06-30" }), /both dates/i);
  assert.match(periodProblem({ from: "2026-06-01", to: "" }), /both dates/i);
  assert.match(periodProblem({ from: "not a date", to: "2026-06-30" }), /not a date/);
  assert.match(periodProblem({ from: "2026-06-01", to: "not a date" }), /not a date/);
  assert.match(periodProblem({ from: "2026-06-30", to: "2026-06-01" }), /after its end/);
});

test("one day is a valid range", () => {
  assert.equal(periodProblem({ from: "2026-06-01", to: "2026-06-01" }), null);
});

test("a decade is refused, three financial years is not", () => {
  assert.match(periodProblem({ from: "2016-01-01", to: "2026-12-31" }), /over three years/);
  assert.equal(periodProblem({ from: "2024-06-01", to: "2026-12-31" }), null);
  // The cap is a parameter, and the message counts in words rather than
  // digits -- it is shown to the shopkeeper, not logged.
  assert.match(
    periodProblem({ from: "2026-01-01", to: "2027-06-01", maxDays: 365 }),
    /over one year/
  );
  assert.equal(periodProblem({ from: "2026-01-01", to: "2026-06-01", maxDays: 365 }), null);
  // The default allows this one; the tighter cap does not. Same dates.
  assert.equal(periodProblem({ from: "2026-01-01", to: "2027-06-01" }), null);
});

test("an empty period has no days and no problem of its own", () => {
  assert.equal(periodDays({ from: "", to: "" }), 0);
  assert.equal(periodDays({ from: "2026-06-30", to: "2026-06-01" }), 0);
});

console.log("\n--- the Mongo window ---");

test("it is widened by a day at each edge, and the pure module cuts", () => {
  const w = queryWindow("2026-04-01", "2026-04-30");
  // 31 March at UTC midnight, so an entry stored at 2026-03-31T18:30:00Z --
  // which IS 1 April in IST -- is inside the query and kept by the IST cut.
  assert.equal(w.$gte.toISOString(), "2026-03-31T00:00:00.000Z");
  assert.equal(w.$lte.toISOString(), "2026-05-01T23:59:59.999Z");
});

test("the widened window actually contains the edge cases that matter", () => {
  const w = queryWindow("2026-04-01", "2026-04-30");
  // 1 April, 00:30 IST.
  const firstEarly = new Date("2026-03-31T19:00:00Z");
  // 30 April, 23:30 IST.
  const lastLate = new Date("2026-04-30T18:00:00Z");
  for (const d of [firstEarly, lastLate]) {
    assert.ok(d >= w.$gte && d <= w.$lte, d.toISOString());
  }
  // A narrow window built from the same dates would MISS the first one,
  // which is the whole reason for the widening.
  const narrow = { $gte: new Date("2026-04-01T00:00:00Z"), $lte: new Date("2026-04-30T23:59:59.999Z") };
  assert.ok(firstEarly < narrow.$gte);
});

test("an unusable range has no window, rather than a window over everything", () => {
  assert.equal(queryWindow("", "2026-04-30"), null);
  assert.equal(queryWindow("2026-04-01", "oops"), null);
});

console.log("\n--- the no-needless-request guard ---");

test("the same two dates are the same period, whatever the preset says", () => {
  // Custom set to this month's dates IS this month, and should not cost a
  // round trip.
  assert.equal(samePeriod(at("thisMonth"), at("custom", { from: "2026-10-01", to: "2026-10-31" })), true);
  assert.equal(samePeriod(at("thisMonth"), at("prevMonth")), false);
  // BOTH ends are compared. Comparing only the start would call a one-day
  // range and a whole month the same period, and the report would keep
  // showing the month after the user narrowed it.
  assert.equal(samePeriod({ from: "2026-10-01", to: "2026-10-31" }, { from: "2026-10-01", to: "2026-10-01" }), false);
  assert.equal(samePeriod({ from: "2026-10-01", to: "2026-10-31" }, { from: "2026-10-02", to: "2026-10-31" }), false);
  assert.equal(samePeriod({ from: "2026-10-01", to: "2026-10-31" }, { from: " 2026-10-01 ", to: "2026-10-31" }), true);
});

console.log("\n--- the printed period line ---");

test("dates print the way Sigfa heads a sheet", () => {
  assert.equal(periodText("2026-04-01", "2026-06-30"), "01-04-2026 to 30-06-2026");
  assert.equal(periodText("", ""), "All dates");
});

console.log("\n--- wiring ---");

test("there is one resolver: the dashboard imports it rather than copying it", () => {
  const dash = read("../lib/dashboard.mjs");
  assert.match(dash, /from "\.\/reportPeriods\.mjs"/);
  // Its own copies are gone. A second `fyStart` or `shiftDays` in there is
  // the drift this whole module exists to prevent.
  assert.equal(/export const fyStart =/.test(dash), false, "dashboard still defines fyStart");
  assert.equal(/const shiftDays = \(/.test(dash), false, "dashboard still defines shiftDays");
  assert.equal(/const lastDayOf = \(/.test(dash), false, "dashboard still defines lastDayOf");
  assert.equal(/export const resolvePeriod = \(/.test(dash), false, "dashboard still defines resolvePeriod");
});

test("the dashboard still offers its own narrower menu", () => {
  const dash = read("../lib/dashboard.mjs");
  // Shared resolver, separate menu: a quarter of daily buckets is not a chart.
  assert.match(dash, /export const PERIOD_PRESETS = \[/);
  assert.equal(/thisQuarter/.test(dash), false, "the dashboard menu grew a quarter");
});

test("the account book no longer reads the browser's clock for its dates", () => {
  const page = read("../app/account-book/page.js");
  // Both deleted helpers are quoted in a comment there explaining why; what
  // must be gone is the CODE.
  assert.equal(/^const todayISO = /m.test(page), false, "todayISO is back");
  assert.equal(/^const fyStart = /m.test(page), false, "fyStart is back");
  assert.match(page, /resolvePeriod\(\{ preset: DEFAULT_PRESET \}\)/);
  assert.match(page, /DateFilter/);
});

test("the shared filter holds no period logic of its own", () => {
  const filter = read("../components/reports/DateFilter.jsx");
  assert.match(filter, /from '@\/lib\/reportPeriods\.mjs'/);
  // No month arithmetic in a component. A component that worked out its own
  // month ends would be the second resolver.
  assert.equal(/getMonth\(\)|getFullYear\(\)|Date\.UTC/.test(filter), false);
});

console.log(`\n  ${passed} checks passed\n`);
