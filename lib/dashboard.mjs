/**
 * The owner's dashboard: sales trends, receivables, payables, low stock and
 * month-on-month comparison.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/dashboard.test.mjs directly.
 *
 *
 * THIS MODULE COMPUTES ALMOST NOTHING OF ITS OWN
 * ----------------------------------------------
 * Every figure here already has an authoritative source in this app, and the
 * one thing a dashboard must not do is produce a second opinion about the
 * firm's money. So:
 *
 *   SALES              lib/salesReports.mjs -- `documentsFor` decides what
 *                      counts as a sale and which side it is on, `isReturn`
 *                      which documents are credit notes. Already
 *                      mutation-tested against Sigfa's own netting rule.
 *
 *   PARTY BALANCES     `Customer.lastBal`, signed, maintained by the posting
 *                      path itself -- save-invoice, sale-alter,
 *                      delete-invoice, voucher-add, voucher-alter and
 *                      delete-voucher all write it through
 *                      lib/balance.mjs's `balancePipeline`, atomically. It is
 *                      what the party ledger and the trial balance show, so
 *                      the dashboard showing anything else would mean one of
 *                      the two is wrong.
 *
 *   WHICH SIDE A PARTY IS ON
 *                      lib/accountGroups.mjs. Group 27 is Sundry Debtors and
 *                      28 is Sundry Creditors, and `resolveGroup` maps the
 *                      legacy spellings ("customer", "supplier") onto them.
 *                      Not guessed from the sign of the balance -- a customer
 *                      who has paid in advance has a credit balance and is
 *                      still a customer.
 *
 *   STOCK              lib/itemStock.mjs's `buildStockIndex`, fed the batched
 *                      ItemLedger aggregation. NOT `Item.lastQuantity`, which
 *                      nothing in the posting path writes.
 *
 *   RECEIPTS, PAYMENTS The Voucher collection's own entries. Deliberately not
 *                      the Ledger, because invoice postings and voucher
 *                      postings both write Ledger rows and both carry a
 *                      `voucherId` -- summing that column would count a
 *                      credit sale as money received.
 *
 *
 * PERIOD FIGURES AND POINT-IN-TIME FIGURES ARE DIFFERENT THINGS
 * ------------------------------------------------------------
 * Sales in March is a period figure. What a customer owes is not: it is what
 * they owe NOW, the sum of everything since they opened an account. Filtering
 * a balance by a date range would produce a number that means nothing -- not
 * the balance, not the period's movement.
 *
 * So the date filter moves the sales, the receipts and the comparison, and
 * does NOT move the receivables, the payables or the stock. `POINT_IN_TIME`
 * names them and the screen says so where they appear.
 *
 *
 * WHAT IS NOT CLAIMED
 * -------------------
 * No due dates exist on an invoice or a party in this app, so nothing here
 * reports an overdue figure. `OVERDUE_UNAVAILABLE` carries the reason and the
 * screen prints it, rather than ageing from the invoice date and calling the
 * guess a due date.
 *
 * No profit either. Sales are not profit, and cost of goods sold would need
 * the valuation and the expense side -- which the Trading account and the P&L
 * already do properly, under lib/financials.mjs, where a reader expects to
 * find them.
 *
 *
 * TWO KINDS OF DAY NUMBER, AND THIS MODULE NEEDS BOTH
 * --------------------------------------------------
 * `istDayNumber` is `yyyymmdd`: right for comparing and sorting, wrong to
 * subtract -- 1 January to 31 December differs by 1130 under it, not 364.
 * Everything here that COUNTS days, steps through them or takes a modulus of
 * them uses `istDayIndex`, a true count since 1970. The first draft of this
 * module subtracted the key, and a year-long chart came out at "months"
 * because it thought the year was three years long.
 */

import { round2 } from "./balance.mjs";
import { dayIndexToIso, istDayIndex, istDayNumber, istParts } from "./istDate.mjs";
import { documentsFor, isReturn, totalsOf } from "./salesReports.mjs";
import { resolveGroup } from "./accountGroups.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const pad = (n) => String(n).padStart(2, "0");

/* ──────────────────────────── the period ────────────────────────────── */

export const PERIOD_PRESETS = [
  "today",
  "last7",
  "last30",
  "thisMonth",
  "prevMonth",
  "thisFy",
  "custom",
];

export const PRESET_LABELS = {
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  thisMonth: "This month",
  prevMonth: "Previous month",
  thisFy: "This financial year",
  custom: "Custom range",
};

export const isPreset = (preset) => PERIOD_PRESETS.includes(text(preset));

/** The IST calendar date of an instant, as yyyy-mm-dd. */
export const istIso = (value) => {
  const p = istParts(value);
  if (!p) return "";
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** `n` days before an IST date, as yyyy-mm-dd. */
const shiftDays = (iso, days) => {
  const [y, m, d] = text(iso).split("-").map(Number);
  if (!y || !m || !d) return "";
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
};

/** The last day of a month, 1-12. */
const lastDayOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * An Indian financial year runs 1 April to 31 March, so a date in January
 * belongs to the year that started the previous April.
 */
export const fyStart = (parts) => (parts.month >= 4 ? parts.year : parts.year - 1);

/**
 * A preset turned into two IST dates.
 *
 * `now` is injected rather than read from the clock, so the tests can stand
 * on a fixed day and so nothing here depends on the server's timezone.
 */
export const resolvePeriod = ({ preset = "thisMonth", now = Date.now(), from, to } = {}) => {
  const p = istParts(now);
  const today = istIso(now);

  switch (text(preset)) {
    case "today":
      return { preset: "today", from: today, to: today, label: PRESET_LABELS.today };
    case "last7":
      // Seven days INCLUDING today, so "last 7 days" is seven days of books.
      return { preset: "last7", from: shiftDays(today, -6), to: today, label: PRESET_LABELS.last7 };
    case "last30":
      return { preset: "last30", from: shiftDays(today, -29), to: today, label: PRESET_LABELS.last30 };
    case "prevMonth": {
      const year = p.month === 1 ? p.year - 1 : p.year;
      const month = p.month === 1 ? 12 : p.month - 1;
      return {
        preset: "prevMonth",
        from: `${year}-${pad(month)}-01`,
        to: `${year}-${pad(month)}-${pad(lastDayOf(year, month))}`,
        label: PRESET_LABELS.prevMonth,
      };
    }
    case "thisFy": {
      const start = fyStart(p);
      return {
        preset: "thisFy",
        from: `${start}-04-01`,
        to: `${start + 1}-03-31`,
        label: `FY ${start}-${String(start + 1).slice(2)}`,
      };
    }
    case "custom":
      return { preset: "custom", from: text(from), to: text(to), label: PRESET_LABELS.custom };
    default:
      return {
        preset: "thisMonth",
        from: `${p.year}-${pad(p.month)}-01`,
        to: `${p.year}-${pad(p.month)}-${pad(lastDayOf(p.year, p.month))}`,
        label: PRESET_LABELS.thisMonth,
      };
  }
};

/** Why this period cannot be used, or null. Checked on the server. */
export const periodProblem = ({ from, to } = {}) => {
  if (!text(from) || !text(to)) return "Give both dates.";
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  if (start === null) return `"${from}" is not a date.`;
  if (end === null) return `"${to}" is not a date.`;
  if (start > end) return "The start of the range is after its end.";
  // A range of years would load a decade of books to draw one chart.
  if (end - start > 1100) return "That range is over three years. Narrow it.";
  return null;
};

/**
 * The period before this one, for the comparison.
 *
 * THE LENGTHS MATCH. For a 30-day window it is the 30 days before it; for a
 * month it is the previous month, cut to the same number of days when this
 * month is still running. Comparing a half-finished March against the whole
 * of February is the commonest way a dashboard invents a collapse in sales,
 * so `partial` says when the cut was made and the screen prints it.
 */
export const previousPeriod = ({ from, to, now = Date.now() } = {}) => {
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  if (start === null || end === null || start > end) return null;

  const p = istParts(from);
  const endParts = istParts(to);
  const firstOfMonth = p && p.day === 1;
  const wholeMonth =
    firstOfMonth && endParts && endParts.day === lastDayOf(endParts.year, endParts.month);

  if (wholeMonth && p.year === endParts.year && p.month === endParts.month) {
    const year = p.month === 1 ? p.year - 1 : p.year;
    const month = p.month === 1 ? 12 : p.month - 1;
    const last = lastDayOf(year, month);

    // Is the period still running? Then the comparison is cut to the same
    // number of days elapsed, so like is compared with like.
    const nowParts = istParts(now);
    const running =
      nowParts && nowParts.year === p.year && nowParts.month === p.month &&
      nowParts.day < lastDayOf(p.year, p.month);
    const days = running ? Math.min(nowParts.day, last) : last;

    return {
      from: `${year}-${pad(month)}-01`,
      to: `${year}-${pad(month)}-${pad(days)}`,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      partial: running ? `the first ${days} day${days === 1 ? "" : "s"}` : null,
    };
  }

  const length = end - start + 1;
  return {
    from: shiftDays(from, -length),
    to: shiftDays(from, -1),
    label: `the ${length} day${length === 1 ? "" : "s"} before`,
    partial: null,
  };
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/* ────────────────────────── sales and purchases ─────────────────────── */

/**
 * Gross, returns and net over a set of book rows.
 *
 * ALL THREE INCLUDE GST, and are the invoice value -- what the party was
 * charged, freight and overheads included. That is the figure on the bill and
 * the figure that hits the party's ledger, so it is the one a trader means by
 * "sales". The taxable value is carried alongside, for the reader who wants
 * the pre-tax figure, rather than left to be guessed at.
 *
 * `documentsFor` decided what counts; this only adds up.
 */
export const trendMetrics = (rows = []) => {
  let gross = 0;
  let returns = 0;
  let grossCount = 0;
  let returnCount = 0;

  for (const row of rows) {
    if (row?.isReturn) {
      returns = round2(returns + num(row.total));
      returnCount += 1;
    } else {
      gross = round2(gross + num(row.total));
      grossCount += 1;
    }
  }

  const totals = totalsOf(rows);

  return {
    gross,
    returns,
    net: round2(gross - returns),
    invoices: grossCount,
    returnNotes: returnCount,
    // Per INVOICE, not per document: a credit note is not a sale, and
    // dividing by the two together understates the average bill.
    average: grossCount ? round2(gross / grossCount) : 0,
    // The same body of documents before tax, so the two can be shown side by
    // side without either being recomputed.
    taxable: totals.taxable,
    gst: totals.gst,
  };
};

/** How finely the chart is cut. A year of days is unreadable. */
export const CHART_GRAINS = ["day", "week", "month"];

/**
 * The grain a period deserves, unless one was asked for.
 *
 * Up to six weeks reads as days; up to about two years as weeks; beyond
 * that, months.
 */
export const grainFor = ({ from, to }) => {
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  if (start === null || end === null) return "day";
  const days = end - start + 1;
  if (days <= 45) return "day";
  if (days <= 730) return "week";
  return "month";
};

/** The bucket a row falls in, at this grain. */
export const bucketOf = (row, grain) => {
  const p = istParts(row?.date);
  if (!p) return null;
  if (text(grain) === "month") return `${p.year}-${pad(p.month)}`;
  if (text(grain) === "week") {
    // Weeks anchored on the Monday the date falls in, so a bar is always
    // seven days of books and never a ragged remainder. The modulus needs a
    // true day COUNT: `yyyymmdd` mod 7 is meaningless.
    const day = istDayIndex(row.date);
    if (day === null) return null;
    // 1 Jan 1970 was a Thursday, so index 0 is a Thursday: +3 moves the
    // epoch onto a Monday before the division.
    const monday = day - ((day + 3) % 7);
    // Dated rather than numbered, so a key is readable in a CSV and sorts as
    // text as well as it does as a date.
    return `W${dayIndexToIso(monday)}`;
  }
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** That bucket as it is printed. */
export const bucketLabel = (key, grain) => {
  const k = text(key);
  if (k.startsWith("W")) {
    const parts = k.slice(1).split("-").map(Number);
    if (parts.length < 3 || !parts[0] || !parts[1]) return k;
    return `${parts[2]} ${MONTH_NAMES[parts[1] - 1]}`;
  }
  const parts = k.split("-").map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) return k;
  const month = `${MONTH_NAMES[parts[1] - 1]} ${parts[0]}`;
  if (parts.length < 3) return month;
  return `${parts[2]} ${MONTH_NAMES[parts[1] - 1]}`;
};

/**
 * The chart's bars: one per bucket, gross and returns side by side.
 *
 * EVERY BUCKET IN THE PERIOD APPEARS, including the ones with no business in
 * them. A chart that skips its empty days draws a straight line through a
 * week the shop was shut and reads as steady trade.
 */
export const trendSeries = ({ rows = [], from, to, grain } = {}) => {
  const cut = CHART_GRAINS.includes(text(grain)) ? text(grain) : grainFor({ from, to });
  const start = istDayIndex(from);
  const end = istDayIndex(to);
  const buckets = new Map();

  // Lay out the empty buckets first, so the gaps are in the series.
  if (start !== null && end !== null) {
    for (let day = start; day <= end; day += 1) {
      // A UTC midnight read back as an IST day is the same calendar day:
      // 00:00Z is 05:30 IST, still that morning.
      const key = bucketOf({ date: day * 86400000 }, cut);
      if (key && !buckets.has(key)) {
        buckets.set(key, { key, label: bucketLabel(key, cut), gross: 0, returns: 0, net: 0, invoices: 0 });
      }
    }
  }

  for (const row of rows) {
    const key = bucketOf(row, cut);
    if (key === null) continue;
    if (!buckets.has(key)) {
      buckets.set(key, { key, label: bucketLabel(key, cut), gross: 0, returns: 0, net: 0, invoices: 0 });
    }
    const b = buckets.get(key);
    if (row.isReturn) b.returns = round2(b.returns + num(row.total));
    else {
      b.gross = round2(b.gross + num(row.total));
      b.invoices += 1;
    }
    b.net = round2(b.gross - b.returns);
  }

  return [...buckets.values()].sort((a, b) => sortKey(a.key) - sortKey(b.key));
};

/**
 * Buckets sort by the day they start on, whatever shape the key is.
 *
 * A month key has no day, and defaulting it to the 1st is what makes
 * "2026-06" sort before "2026-06-15" -- which never happens, because one
 * series is cut at one grain.
 */
const sortKey = (key) => {
  const [y, m, d] = text(key).replace(/^W/, "").split("-").map(Number);
  if (!y) return 0;
  return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000;
};

/**
 * One metric, this period against last.
 *
 * `pct` is null rather than Infinity when the previous figure was nothing --
 * there is no percentage increase from zero, and `direction: "new"` says what
 * actually happened. Zero to zero is "same", not a 0% rise.
 */
export const compare = (current, previous) => {
  const now = round2(num(current));
  const before = round2(num(previous));
  const diff = round2(now - before);

  let direction = "same";
  if (diff > 0) direction = "up";
  else if (diff < 0) direction = "down";

  let pct = null;
  if (before !== 0) pct = round2((diff / Math.abs(before)) * 100);
  else if (now !== 0) direction = "new";

  return { current: now, previous: before, diff, pct, direction };
};

/* ──────────────────── receivables and payables ──────────────────────── */

/**
 * The figures that are NOT period figures. The screen labels these.
 */
export const POINT_IN_TIME = ["receivables", "payables", "stock"];

export const OVERDUE_UNAVAILABLE =
  "No due date is recorded on an invoice or a party, so nothing here is reported as overdue.";

export const PARTY_SIDES = {
  receivable: { group: "Sundry Debtors", label: "Customers", owes: "us" },
  payable: { group: "Sundry Creditors", label: "Suppliers", owes: "them" },
};

export const isPartySide = (side) => Object.hasOwn(PARTY_SIDES, text(side));

/**
 * Is this party on this side of the book?
 *
 * By their GROUP, through lib/accountGroups.mjs, not by the sign of their
 * balance. A customer in credit because they paid in advance is still a
 * customer, and classifying by sign would move them into the payables and
 * overstate what the firm owes.
 *
 * `resolveGroup` returns the GROUP RECORD, not its name -- an unnamed group
 * comes back as null. Comparing the record to a string put every party on
 * neither side and showed a firm with no receivables at all.
 */
export const groupNameOf = (party) => text(resolveGroup(text(party?.group))?.name);

export const onSide = (party, side) => {
  const want = PARTY_SIDES[text(side)];
  if (!want) return false;
  return groupNameOf(party) === want.group;
};

/**
 * One row per party with something outstanding, biggest first.
 *
 * THE SIGN DECIDES WHAT IT MEANS. Balances are signed: positive is Dr,
 * negative is Cr (lib/balance.mjs). So on the receivable side a positive
 * balance is money owed TO the firm, and a negative one is an advance the
 * customer has already paid -- not a receivable, and not a payable either.
 * The same in reverse for a supplier.
 *
 * `outstanding` is therefore always a positive magnitude of the thing the
 * side is about, and the advances come back separately so they can be shown
 * without being added to a total they do not belong in.
 */
export const partyRows = ({ customers = [], side = "receivable" } = {}) => {
  const want = PARTY_SIDES[text(side)];
  if (!want) return { rows: [], advances: [] };

  // A receivable is a debit balance; a payable is a credit balance.
  const wanted = text(side) === "receivable" ? 1 : -1;

  const rows = [];
  const advances = [];

  for (const party of customers) {
    if (!onSide(party, side)) continue;
    const signed = round2(num(party?.lastBal));
    if (signed === 0) continue;

    const entry = {
      // The party ledger is reached by id, not by name -- two parties can be
      // renamed into each other, and a name in a URL is a name to escape.
      id: text(party?._id ?? party?.id),
      name: text(party?.name),
      city: text(party?.city),
      phone: text(party?.phone),
      group: groupNameOf(party),
      signed,
      outstanding: Math.abs(signed),
      // The portal-style words a reader expects beside a balance.
      mode: signed >= 0 ? "Dr" : "Cr",
    };

    if (Math.sign(signed) === wanted) rows.push(entry);
    else advances.push(entry);
  }

  rows.sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  advances.sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));

  return { rows, advances };
};

/**
 * The cards above the table.
 *
 * `total` is the sum of the rows below it and nothing else, so the card and
 * the table reconcile by construction rather than by agreement.
 */
export const partySummary = ({ rows = [], advances = [], collected = null } = {}) => ({
  total: round2(rows.reduce((t, r) => t + num(r.outstanding), 0)),
  parties: rows.length,
  advances: round2(advances.reduce((t, r) => t + num(r.outstanding), 0)),
  advanceParties: advances.length,
  // Null when it could not be derived, rather than a zero that reads as
  // "nothing came in".
  collected: collected === null ? null : round2(collected),
  overdue: null,
  overdueNote: OVERDUE_UNAVAILABLE,
});

/** Narrow the table by what was typed, and sort it. */
export const PARTY_SORTS = ["amount", "name"];

export const filterParties = ({ rows = [], search = "", sort = "amount" } = {}) => {
  const needle = text(search).toLowerCase();
  const out = rows.filter(
    (r) =>
      !needle ||
      text(r?.name).toLowerCase().includes(needle) ||
      text(r?.city).toLowerCase().includes(needle)
  );
  if (text(sort) === "name") {
    return [...out].sort((a, b) => text(a.name).localeCompare(text(b.name)));
  }
  return out;
};

/** One page of a long list. Page numbers are one-based, as a person counts. */
export const paginate = (rows = [], page = 1, size = 20) => {
  const per = Math.max(1, num(size));
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const at = Math.min(Math.max(1, num(page) || 1), pages);
  return { page: at, pages, size: per, total: rows.length, rows: rows.slice((at - 1) * per, at * per) };
};

/**
 * The vouchers that fall inside a window.
 *
 * Cut by IST calendar day, like every other date comparison in this app. It
 * lives here rather than in the route because the route fetches ONE window
 * wide enough for the period and the one before it, and then needs each
 * period's slice of it -- a filter the route must not write twice.
 */
export const vouchersIn = ({ vouchers = [], from, to } = {}) => {
  const start = from ? istDayNumber(from) : null;
  const end = to ? istDayNumber(to) : null;

  return vouchers.filter((voucher) => {
    const day = istDayNumber(voucher?.date);
    if (day === null) return false;
    if (start !== null && day < start) return false;
    if (end !== null && day > end) return false;
    return true;
  });
};

/**
 * Money that actually moved in the period, from the vouchers themselves.
 *
 * `side` picks the direction: a receipt CREDITS a customer (it reduces what
 * they owe) and a payment DEBITS a supplier. Read off the Voucher entries
 * rather than the Ledger, because invoice postings write Ledger rows too and
 * summing those would count a credit sale as money received.
 */
export const movedInPeriod = ({ vouchers = [], parties = new Set(), side = "receivable" } = {}) => {
  const field = text(side) === "receivable" ? "credit" : "debit";
  let total = 0;

  for (const voucher of vouchers) {
    for (const entry of voucher?.entries || voucher?.customers || []) {
      const name = text(entry?.name);
      if (!parties.has(name)) continue;
      total = round2(total + num(entry?.[field]));
    }
  }

  return round2(total);
};

/* ──────────────────────────── low stock ─────────────────────────────── */

/**
 * What counts as "low".
 *
 * `minQuantity` on the item master is OPTIONAL and new. An item that has
 * never had one set is NOT compared against an invented default -- a
 * wholesaler's minimum for steel plate is not a shop's for washers, and a
 * made-up number would fill the alert list with items nobody asked about.
 *
 * Such an item is still reported when its stock has run out or gone negative,
 * because that needs no threshold to be worth knowing.
 */
export const STOCK_REASONS = ["negative", "out", "below"];

export const STOCK_REASON_LABELS = {
  negative: "Negative stock",
  out: "Out of stock",
  below: "Below minimum",
};

export const stockReason = (quantity, minimum) => {
  const qty = num(quantity);
  if (qty < 0) return "negative";
  if (qty === 0) return "out";
  const min = minimum === null || minimum === undefined ? null : num(minimum);
  if (min !== null && min > 0 && qty < min) return "below";
  return null;
};

/**
 * The alert rows, most urgent first.
 *
 * `stock` is lib/itemStock.mjs's index -- the authoritative figure, summed
 * from the item ledger rather than read off `Item.lastQuantity`.
 */
export const lowStockRows = ({ stock = [], items = [] } = {}) => {
  const master = new Map();
  for (const item of items) {
    const name = text(item?.name);
    if (name) master.set(name.toLowerCase(), item);
  }

  const order = { negative: 0, out: 1, below: 2 };
  const rows = [];

  for (const entry of stock) {
    const name = text(entry?.name);
    const item = master.get(name.toLowerCase());
    const minimum =
      item?.minQuantity === null || item?.minQuantity === undefined ? null : num(item.minQuantity);
    const reason = stockReason(entry?.quantity, minimum);
    if (!reason) continue;

    rows.push({
      // Absent for a movement whose item has been deleted from the master,
      // in which case the screen shows the row without a link rather than
      // linking to nothing.
      id: text(item?._id ?? item?.id),
      name,
      quantity: round2(num(entry?.quantity)),
      unit: text(entry?.unit) || text(item?.unit),
      minimum,
      // How much would bring it back to the minimum. Null without one, rather
      // than a shortfall measured against a number nobody set.
      shortfall: minimum === null ? null : round2(Math.max(0, minimum - num(entry?.quantity))),
      hsn: text(item?.hsn),
      reason,
      reasonLabel: STOCK_REASON_LABELS[reason],
    });
  }

  return rows.sort(
    (a, b) => order[a.reason] - order[b.reason] || a.quantity - b.quantity || a.name.localeCompare(b.name)
  );
};

/** The cards above the stock table. */
export const stockSummary = ({ rows = [], stock = [], items = [] } = {}) => {
  const configured = items.filter(
    (i) => i?.minQuantity !== null && i?.minQuantity !== undefined && num(i.minQuantity) > 0
  ).length;

  return {
    alerts: rows.length,
    negative: rows.filter((r) => r.reason === "negative").length,
    out: rows.filter((r) => r.reason === "out").length,
    below: rows.filter((r) => r.reason === "below").length,
    items: stock.length,
    // So the screen can say how much of the master is actually covered by a
    // threshold, instead of implying the alert list is the whole picture.
    withMinimum: configured,
    withoutMinimum: Math.max(0, items.length - configured),
  };
};

/* ───────────────────── the monthly comparison ───────────────────────── */

/**
 * Which metrics are compared, and what each one actually measures.
 *
 * `measure` is carried so the screen can print it: an invoice total, money
 * received and a closing balance are three different things, and a column of
 * numbers with no word for which is which is how a dashboard misleads.
 */
export const COMPARISON_METRICS = [
  { key: "grossSales", label: "Gross sales", measure: "Invoiced, GST included" },
  { key: "salesReturns", label: "Sales returns", measure: "Credit notes raised" },
  { key: "netSales", label: "Net sales", measure: "Gross less returns" },
  { key: "grossPurchases", label: "Purchases", measure: "Billed to us, GST included" },
  { key: "purchaseReturns", label: "Purchase returns", measure: "Debit notes raised" },
  { key: "netPurchases", label: "Net purchases", measure: "Gross less returns" },
  { key: "receipts", label: "Customer receipts", measure: "Money actually received" },
  { key: "payments", label: "Supplier payments", measure: "Money actually paid" },
];

/**
 * The comparison table.
 *
 * Receivables and payables are deliberately NOT in it. They are balances as
 * at today; there is no "last month's receivables" to compare against without
 * replaying every posting to the end of last month, and this app does not
 * store a dated balance. Reporting today's figure in both columns, or
 * subtracting one period's invoices from it, would both be wrong.
 */
export const comparisonRows = ({ current = {}, previous = {} } = {}) =>
  COMPARISON_METRICS.map((metric) => ({
    ...metric,
    ...compare(current[metric.key], previous[metric.key]),
  }));

/** The figures one period contributes to the comparison. */
export const periodFigures = ({
  invoices = [],
  vouchers = [],
  customerNames = new Set(),
  supplierNames = new Set(),
  from,
  to,
} = {}) => {
  const sales = trendMetrics(documentsFor({ invoices, side: "Sale", from, to }));
  const purchases = trendMetrics(documentsFor({ invoices, side: "Purchase", from, to }));

  return {
    grossSales: sales.gross,
    salesReturns: sales.returns,
    netSales: sales.net,
    grossPurchases: purchases.gross,
    purchaseReturns: purchases.returns,
    netPurchases: purchases.net,
    receipts: movedInPeriod({ vouchers, parties: customerNames, side: "receivable" }),
    payments: movedInPeriod({ vouchers, parties: supplierNames, side: "payable" }),
  };
};

/** Re-exported so the route and the screen need only this module. */
export { documentsFor, isReturn };
