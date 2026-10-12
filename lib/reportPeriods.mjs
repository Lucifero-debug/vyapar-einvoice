/**
 * Every report's date filter, in one place.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/report-periods.test.mjs directly. Never import Mongoose in here.
 *
 *
 * THERE IS ONE PRESET LIST AND ONE RESOLVER
 * -----------------------------------------
 * lib/dashboard.mjs had seven of these presets and its own copy of the IST
 * date arithmetic. It now imports from here and re-exports the seven it
 * offers on its own screen, so the dashboard's "This month" and a sales
 * report's "This month" are the same two dates by construction rather than by
 * coincidence. A second resolver is how one screen's March ends on the 31st
 * and another's on the 30th.
 *
 *
 * THE FINANCIAL YEAR RUNS 1 APRIL TO 31 MARCH
 * -------------------------------------------
 * India's does, and this is a GST billing application for Indian trading
 * firms. There is no per-firm accounting-year field on `companies`
 * (models/companyModel.js) -- so rather than assume a calendar year, which
 * would be wrong for every user of this app, the boundary is the one constant
 * `FY_START_MONTH` below. A firm on a different year is a schema change and a
 * read of that field here, not a rewrite.
 *
 *
 * AND SO DO THE QUARTERS
 * ----------------------
 * "This quarter" means the FINANCIAL quarter -- Apr-Jun, Jul-Sep, Oct-Dec,
 * Jan-Mar -- not the calendar one. In an accounting application whose year
 * starts in April, a Q1 running January to March is a quarter that belongs to
 * the previous year's books, and GSTR-1 filers reckon quarters the same way.
 * Calendar quarters would be a different, defensible choice for a sales chart
 * and the wrong one for a report that has to tie to a return.
 *
 *
 * A WEEK STARTS ON MONDAY
 * -----------------------
 * ISO 8601, and what a shop means by "this week" when Sunday is the day off.
 * `WEEK_START` names it so the choice is visible rather than buried in a
 * modulus.
 *
 *
 * DATES ARE IST CALENDAR DAYS, AND THE WINDOW IS INCLUSIVE
 * --------------------------------------------------------
 * Both ends. A report "from 1 April to 30 April" includes everything dated
 * the 30th, up to 23:59:59.999 IST. The container runs Asia/Calcutta and
 * Vercel runs UTC, so every boundary here goes through lib/istDate.mjs and
 * never through a local-clock `new Date()`; an invoice saved at 11pm IST on
 * the 30th is dated the 30th in UTC terms at 17:30, and a naive UTC day
 * window drops or duplicates it.
 *
 * `queryWindow` therefore WIDENS the Mongo filter by a day at each edge and
 * leaves the exact cut to the pure module that owns the report -- the rule
 * PROJECT_CONTEXT.md states for every dated query in this app.
 *
 *
 * A RUNNING PERIOD RUNS TO ITS OWN END, NOT TO TODAY
 * -------------------------------------------------
 * "This month" on the 12th resolves to the 1st through the 31st, not through
 * the 12th. Every "this" preset behaves that way -- week, month, quarter,
 * financial year -- because a report asked for this month is asked for this
 * month's sheet, and there are no documents dated in the future to pick up.
 *
 * It matters in exactly one place, and that place already handles it:
 * `previousPeriod` in lib/dashboard.mjs compares a half-finished month
 * against the same number of elapsed days of the month before, and reports
 * the cut, precisely so a comparison does not read as a collapse. That cut
 * belongs to the COMPARISON, not to the period -- putting it here would make
 * "this month" mean two different ranges depending on which screen asked,
 * and would stop the whole-month detection that comparison depends on from
 * ever firing.
 */

import { istDayIndex, istParts } from "./istDate.mjs";

const text = (value) => String(value ?? "").trim();
const pad = (n) => String(n).padStart(2, "0");

/** 4 = April. See the header. */
export const FY_START_MONTH = 4;

/** 1 = Monday. See the header. */
export const WEEK_START = 1;

/* ────────────────────────────── the presets ──────────────────────────── */

/**
 * Every preset, in the order a picker should show them, grouped the way a
 * person thinks about periods: days, weeks, months, quarters, years.
 */
export const PRESET_GROUPS = [
  { label: "Days", keys: ["today", "yesterday", "last7", "last30"] },
  { label: "Weeks", keys: ["thisWeek", "prevWeek"] },
  { label: "Months", keys: ["thisMonth", "prevMonth"] },
  { label: "Quarters", keys: ["thisQuarter", "prevQuarter"] },
  { label: "Years", keys: ["thisFy", "prevFy"] },
  { label: "", keys: ["custom"] },
];

export const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.keys);

export const PRESET_LABELS = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  thisWeek: "This week",
  prevWeek: "Previous week",
  thisMonth: "This month",
  prevMonth: "Previous month",
  thisQuarter: "This quarter",
  prevQuarter: "Previous quarter",
  thisFy: "This financial year",
  prevFy: "Previous financial year",
  custom: "Custom range",
};

export const isPreset = (preset) => ALL_PRESETS.includes(text(preset));

/* ───────────────────────────── IST day maths ─────────────────────────── */

/** The IST calendar date of an instant, as yyyy-mm-dd. */
export const istIso = (value) => {
  const p = istParts(value);
  if (!p) return "";
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/**
 * `n` days from an IST date, as yyyy-mm-dd. Negative goes back.
 *
 * Done in UTC on purpose: `Date.UTC(y, m - 1, d + days)` carries across month
 * and year ends correctly and has no daylight-saving to trip over, which is
 * the whole reason not to use a local Date here.
 */
export const shiftDays = (iso, days) => {
  const [y, m, d] = text(iso).split("-").map(Number);
  if (!y || !m || !d) return "";
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
};

/** The last day of a month, month being 1-12. */
export const lastDayOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Which calendar year a date's financial year STARTED in. */
export const fyStart = (parts) =>
  parts.month >= FY_START_MONTH ? parts.year : parts.year - 1;

/** "FY 2026-27". */
export const fyLabel = (start) => `FY ${start}-${String(start + 1).slice(2)}`;

/** The whole financial year that started in `start`. */
const fyRange = (start) => ({
  from: `${start}-${pad(FY_START_MONTH)}-01`,
  to: `${start + 1}-${pad(FY_START_MONTH - 1)}-${pad(lastDayOf(start + 1, FY_START_MONTH - 1))}`,
});

/**
 * Which financial quarter a date falls in: 1-4, counting from the FY start.
 *
 * April is quarter 1. January is quarter 4 of the year that began the
 * previous April -- which is why this takes the FY start rather than the
 * calendar year.
 */
export const fyQuarter = (parts) => {
  const offset = (parts.month - FY_START_MONTH + 12) % 12;
  return Math.floor(offset / 3) + 1;
};

/** The dates of one financial quarter. `quarter` is 1-4, `start` the FY. */
const quarterRange = (start, quarter) => {
  const firstMonth = ((FY_START_MONTH - 1 + (quarter - 1) * 3) % 12) + 1;
  const firstYear = FY_START_MONTH - 1 + (quarter - 1) * 3 >= 12 ? start + 1 : start;
  const lastMonthIndex = FY_START_MONTH - 1 + (quarter - 1) * 3 + 2;
  const lastMonth = (lastMonthIndex % 12) + 1;
  const lastYear = lastMonthIndex >= 12 ? start + 1 : start;
  return {
    from: `${firstYear}-${pad(firstMonth)}-01`,
    to: `${lastYear}-${pad(lastMonth)}-${pad(lastDayOf(lastYear, lastMonth))}`,
    label: `Q${quarter} ${fyLabel(start)}`,
  };
};

/** The whole of one month. */
const monthRange = (year, month) => ({
  from: `${year}-${pad(month)}-01`,
  to: `${year}-${pad(month)}-${pad(lastDayOf(year, month))}`,
});

/** The ISO weekday of an IST date, 0 = Sunday. */
const weekdayOf = (iso) => {
  const [y, m, d] = text(iso).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The Monday on or before `iso`. */
const weekStartOf = (iso) => {
  const day = weekdayOf(iso);
  if (day === null) return "";
  // Sunday (0) belongs to the week that began the previous Monday, six days
  // back -- not to the one starting tomorrow.
  const back = (day - WEEK_START + 7) % 7;
  return shiftDays(iso, -back);
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/* ─────────────────────────────── resolving ───────────────────────────── */

/**
 * A preset turned into two inclusive IST dates and a label to print.
 *
 * `now` is injected rather than read from the clock, so the tests can stand
 * on a fixed day and nothing here depends on the server's timezone.
 *
 * An unknown preset resolves to This month rather than throwing. This is read
 * from a query string, and a stale bookmark should draw last month's sheet,
 * not a 500 -- the ROUTE validates the preset separately with `isPreset` when
 * it needs to refuse one.
 */
export const resolvePeriod = ({ preset = "thisMonth", now = Date.now(), from, to } = {}) => {
  const p = istParts(now);
  const today = istIso(now);
  const made = (key, range, label) => ({
    preset: key,
    from: range.from,
    to: range.to,
    label: label ?? range.label ?? PRESET_LABELS[key],
  });

  switch (text(preset)) {
    case "today":
      return made("today", { from: today, to: today });
    case "yesterday": {
      const day = shiftDays(today, -1);
      return made("yesterday", { from: day, to: day });
    }
    case "last7":
      // Seven days INCLUDING today, so "last 7 days" is seven days of books
      // and not eight.
      return made("last7", { from: shiftDays(today, -6), to: today });
    case "last30":
      return made("last30", { from: shiftDays(today, -29), to: today });
    case "thisWeek": {
      const start = weekStartOf(today);
      // The WHOLE week, even the part still to come -- see the note on
      // running periods in the header.
      return made("thisWeek", { from: start, to: shiftDays(start, 6) });
    }
    case "prevWeek": {
      const start = shiftDays(weekStartOf(today), -7);
      return made("prevWeek", { from: start, to: shiftDays(start, 6) });
    }
    case "prevMonth": {
      const year = p.month === 1 ? p.year - 1 : p.year;
      const month = p.month === 1 ? 12 : p.month - 1;
      return made("prevMonth", monthRange(year, month), `${MONTH_NAMES[month - 1]} ${year}`);
    }
    case "thisQuarter": {
      const start = fyStart(p);
      const range = quarterRange(start, fyQuarter(p));
      return made("thisQuarter", range, range.label);
    }
    case "prevQuarter": {
      const start = fyStart(p);
      const q = fyQuarter(p);
      // Q1's predecessor is Q4 of the year before.
      return made("prevQuarter", q === 1 ? quarterRange(start - 1, 4) : quarterRange(start, q - 1));
    }
    case "thisFy": {
      const start = fyStart(p);
      return made("thisFy", fyRange(start), fyLabel(start));
    }
    case "prevFy": {
      const start = fyStart(p) - 1;
      return made("prevFy", fyRange(start), fyLabel(start));
    }
    case "custom":
      return made("custom", { from: text(from), to: text(to) }, PRESET_LABELS.custom);
    default:
      return made("thisMonth", monthRange(p.year, p.month), `${MONTH_NAMES[p.month - 1]} ${p.year}`);
  }
};

/**
 * "three years", for the message below.
 *
 * Spelled rather than printed as a digit because the sentence is shown to the
 * shopkeeper, not logged -- and because every caller so far uses a cap of a
 * few years. Past ten it gives up and uses the digits.
 */
const YEAR_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const spellYears = (days) => {
  const years = Math.round(days / 365);
  const word = YEAR_WORDS[years] ?? String(years);
  return `${word} year${years === 1 ? "" : "s"}`;
};

/**
 * Why this period cannot be used, or null. CHECKED ON THE SERVER.
 *
 * `maxDays` caps the range, because a report over a decade loads a decade of
 * books to draw one sheet. The default allows three financial years, which
 * covers "give me everything since we switched over" and refuses "since 1990".
 */
export const periodProblem = ({ from, to, maxDays = 1100 } = {}) => {
  if (!text(from) || !text(to)) return "Give both dates.";
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  if (start === null) return `"${from}" is not a date.`;
  if (end === null) return `"${to}" is not a date.`;
  if (start > end) return "The start of the range is after its end.";
  if (end - start >= maxDays) {
    return `That range is over ${spellYears(maxDays)}. Narrow it.`;
  }
  return null;
};

/** How many days the window covers, both ends included. 0 when invalid. */
export const periodDays = ({ from, to } = {}) => {
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  if (start === null || end === null || start > end) return 0;
  return end - start + 1;
};

/**
 * Are these the same window?
 *
 * The screen uses this to NOT refetch when a filter was re-selected without
 * changing -- the spec's "avoid unnecessary API requests". Compared on the
 * dates rather than the preset, because Custom set to this month's dates IS
 * this month and should not cost a round trip.
 */
export const samePeriod = (a, b) =>
  text(a?.from) === text(b?.from) && text(a?.to) === text(b?.to);

/**
 * The Mongo date filter for this window, WIDENED BY A DAY AT EACH EDGE.
 *
 * Deliberately loose. The exact cut is an IST calendar-day comparison, which
 * Mongo cannot make for us, so the query over-fetches by at most two days and
 * the pure report module trims. Narrowing this to the exact instants is the
 * bug that drops an invoice saved at 11pm IST on the last day of the month --
 * it is stored as 17:30 UTC and a UTC-midnight boundary puts it outside.
 *
 * Returns null when either end is unusable, so a caller can tell "no filter"
 * from "a filter over everything".
 */
export const queryWindow = (from, to) => {
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  if (start === null || end === null) return null;
  const [sy, sm, sd] = text(from).split("-").map(Number);
  const [ey, em, ed] = text(to).split("-").map(Number);
  return {
    $gte: new Date(Date.UTC(sy, sm - 1, sd - 1)),
    $lte: new Date(Date.UTC(ey, em - 1, ed + 1, 23, 59, 59, 999)),
  };
};

/** "01-04-2026 to 30-06-2026", the way Sigfa heads a sheet. */
export const periodText = (from, to) => {
  const asDate = (iso) => {
    const [y, m, d] = text(iso).split("-");
    return y && m && d ? `${d}-${m}-${y}` : text(iso);
  };
  if (!text(from) && !text(to)) return "All dates";
  return `${asDate(from)} to ${asDate(to)}`;
};
