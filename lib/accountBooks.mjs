/**
 * Cash Book, Bank Book and A/C Ledger.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/account-books.test.mjs directly. Never import Mongoose in here.
 *
 *
 * ALL THREE ARE ONE REPORT
 * ------------------------
 * Sigfa has them as separate menu items -- Cash Book, Bank Book, Petty Cash
 * Book, Account Ledger, A/C Ledger Group Wise -- but they are the same sheet
 * with a different account selected: an opening balance, the movements in a
 * date range, a running balance, and a closing figure. Writing them as one
 * thing is not a shortcut; it is the reason a cash book and a party ledger
 * can never disagree about what a balance means.
 *
 * What differs per book is only which accounts are offered, and that lives in
 * lib/accountGroups.mjs.
 *
 *
 * THE RUNNING BALANCE IS RECOMPUTED HERE, NOT READ
 * ------------------------------------------------
 * `Ledger.balance` exists and looks authoritative. It is a cache, maintained
 * by `recomputeLedgerBalances` for the two accounts a posting touched -- so it
 * is right for the party and the cash account on the newest entry and stale
 * for everything a back-dated entry landed in front of. Worse, it is an
 * all-time running figure, which is the wrong number for a book opened from
 * 1 July: the first row would show a balance carried from April.
 *
 * So the balance column is computed from the opening position plus the rows
 * being shown, in a defined order. Same decision as `lib/itemStock.mjs`,
 * which sums the stock ledger rather than trusting `balanceQuantity`: a sum
 * cannot be stale.
 *
 *
 * SIGNS
 * -----
 * Balances are SIGNED throughout this app: positive is Dr, negative is Cr
 * (lib/balance.mjs). A cash account holding money is therefore positive, and
 * an overdrawn bank account is negative -- which is also why the Bank Book
 * includes Bank OD accounts rather than treating them as a different animal.
 */

import { modeOf, round2 } from "./balance.mjs";
import { istDayNumber } from "./istDate.mjs";
import { csvCell, toCsv } from "./orderReports.mjs";

// One CSV writer for the whole app, imported rather than copied. It is already
// hardened in the two ways that matter -- RFC 4180 quoting, because party
// names routinely contain commas, and a leading quote on =, +, - or @, because
// Excel would otherwise evaluate a party name as a formula. A second copy
// would be a second thing to remember. It deserves a module of its own rather
// than living in orderReports.mjs; until it has one, importing is the lesser
// of the two evils.
export { csvCell, toCsv };

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export const BOOK_KINDS = ["cash", "bank", "ledger"];

export const BOOK_NAMES = {
  cash: "Cash Book",
  bank: "Bank Book",
  ledger: "A/C Ledger",
};

export const isBookKind = (kind) => BOOK_KINDS.includes(text(kind));

/** A date, or null. Accepts what a query string and Mongo both hand over. */
const asDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Is this row inside the window? `from` and `to` are inclusive.
 *
 * Compared as IST CALENDAR DAYS, through `istDayNumber`, rather than by
 * building a start-of-day and an end-of-day instant from the local clock. Two
 * reasons, and the first is a bug this project has already paid for once:
 *
 *   A local-clock call reads the SERVER's day. This container runs on
 *   Asia/Calcutta, so it would have looked right here and been wrong on
 *   Vercel, which runs UTC: an entry stored after 6:30pm IST on the 31st
 *   falls on the 31st in UTC but on the 1st in Delhi, and the two hosts
 *   disagreed about whether it belonged in a range ending on the 31st.
 *   Measured, not guessed -- the same fixture returned two rows under UTC and
 *   one under IST. lib/istDate.mjs exists for exactly this, and the
 *   shopkeeper's answer is the Delhi one.
 *
 *   Comparing whole days also makes the inclusive end trivial rather than
 *   delicate: there is no last-millisecond-of-the-day to get wrong, because
 *   the 31st either is or is not within 1 to 31.
 */
export const inWindow = (date, from, to) => {
  const day = istDayNumber(date);
  if (day === null) return false;
  const start = istDayNumber(from);
  if (start !== null && day < start) return false;
  const end = istDayNumber(to);
  if (end !== null && day > end) return false;
  return true;
};

/**
 * The order rows are read in: by date, then by insertion.
 *
 * `_id` as the tie-break, not an arbitrary sort: a Mongo ObjectId begins with
 * a timestamp, so it orders same-day rows the way they were written. The same
 * ordering `recomputeLedgerBalances` uses, which is what lets the recomputed
 * column here agree with the cached one there.
 */
export const inOrder = (rows = []) =>
  [...rows].sort((a, b) => {
    const da = asDate(a?.date)?.getTime() ?? 0;
    const db = asDate(b?.date)?.getTime() ?? 0;
    if (da !== db) return da - db;
    return String(a?._id ?? "").localeCompare(String(b?._id ?? ""));
  });

/**
 * The balance an account stood at immediately before `from`.
 *
 * Its opening balance from the master, plus every movement that happened
 * earlier. Not the stored `balance` of the last row before the window: that
 * figure can be stale, and on an account with no rows at all there is none.
 *
 * With no `from`, the opening balance IS the master's opening balance -- there
 * is nothing before the beginning.
 */
export const openingBefore = ({ rows = [], openingBal = 0, from } = {}) => {
  let running = round2(num(openingBal));
  const start = istDayNumber(from);
  if (start === null) return running;

  for (const row of rows) {
    const day = istDayNumber(row?.date);
    // Strictly earlier: a row dated ON the start date belongs in the window
    // below, not in the figure carried into it.
    if (day === null || day >= start) continue;
    running = round2(running + num(row.debit) - num(row.credit));
  }
  return running;
};

/**
 * One account's book for a date range.
 *
 * Returns the opening figure, the rows with a running balance, the column
 * totals and the closing figure. `closing` is the last row's balance, or the
 * opening when nothing moved -- derived from the same running sum rather than
 * added up a second way, so the two cannot disagree.
 *
 * `particulars` is the CONTRA account, which is what makes a book readable:
 * a cash book line says what the money was for ("Sales Account", a party
 * name), not the name of the book you are already looking at.
 */
export const accountBook = ({
  account,
  rows = [],
  openingBal = 0,
  from,
  to,
} = {}) => {
  const ordered = inOrder(rows);
  const opening = openingBefore({ rows: ordered, openingBal, from });

  let running = opening;
  let debit = 0;
  let credit = 0;
  const lines = [];

  for (const row of ordered) {
    if (!inWindow(row?.date, from, to)) continue;

    const dr = round2(num(row.debit));
    const cr = round2(num(row.credit));
    running = round2(running + dr - cr);
    debit = round2(debit + dr);
    credit = round2(credit + cr);

    lines.push({
      _id: row._id,
      date: asDate(row.date),
      particulars: text(row.account) || "(no contra account)",
      narration: text(row.narration),
      paymentType: text(row.paymentType),
      voucherId: row.voucherId ?? null,
      debit: dr,
      credit: cr,
      balance: running,
      mode: modeOf(running),
    });
  }

  return {
    account: text(account?.name ?? account),
    group: text(account?.group),
    from: asDate(from),
    to: asDate(to),
    opening,
    openingMode: modeOf(opening),
    lines,
    totals: { debit, credit },
    // Not `lines[lines.length - 1].balance`, which would be undefined on an
    // empty range. Arrived at the same way either way.
    closing: running,
    closingMode: modeOf(running),
  };
};

/**
 * Sigfa's "Date Wise Cash Book": one line per day instead of per entry.
 *
 * A till that takes forty small payments a day is unreadable entry by entry,
 * and what the shop actually wants to see is the day's receipts, the day's
 * payments and what was left. The closing balance of each day is the running
 * balance after its last entry, so collapsing the rows cannot change the
 * closing figure -- which a test asserts, because that is the one way a
 * summary can lie.
 */
export const dayWise = (book) => {
  const days = new Map();

  for (const line of book?.lines || []) {
    const d = asDate(line.date);
    // Keyed on the IST calendar day, like the window above -- grouping by the
    // server's day would split one evening's takings across two rows.
    const k = istDayNumber(d);
    if (k === null) continue;

    if (!days.has(k)) {
      days.set(k, {
        day: k,
        date: d,
        entries: 0,
        debit: 0,
        credit: 0,
        balance: 0,
        mode: "Dr",
      });
    }

    const day = days.get(k);
    day.entries += 1;
    day.debit = round2(day.debit + num(line.debit));
    day.credit = round2(day.credit + num(line.credit));
    // The running balance after this line, so the last line of the day wins.
    day.balance = num(line.balance);
    day.mode = modeOf(day.balance);
  }

  return [...days.values()].sort((a, b) => a.day - b.day);
};

/**
 * Sigfa's "A/C Ledger Group Wise": every account in a group, one after
 * another, with the group's own totals.
 *
 * `books` are already-built books. The group total is the sum of the closing
 * balances, which is the figure the trial balance will later take from the
 * same place -- not the sum of the debit and credit columns, which would be
 * the movement in the window rather than a position.
 */
export const groupBook = (groupName, books = []) => {
  let opening = 0;
  let debit = 0;
  let credit = 0;
  let closing = 0;

  for (const book of books) {
    opening = round2(opening + num(book?.opening));
    debit = round2(debit + num(book?.totals?.debit));
    credit = round2(credit + num(book?.totals?.credit));
    closing = round2(closing + num(book?.closing));
  }

  return {
    group: text(groupName),
    books,
    accounts: books.length,
    opening,
    openingMode: modeOf(opening),
    totals: { debit, credit },
    closing,
    closingMode: modeOf(closing),
  };
};

/* ------------------------------------------------------------------ *
 *  Presentation
 * ------------------------------------------------------------------ */

/**
 * A signed balance as a book prints it: a magnitude and a side.
 *
 * Zero is Dr by `modeOf`'s rule, but a book showing "0.00 Dr" reads as a
 * decision somebody made. A flat zero is the honest rendering.
 */
export const balanceText = (signed) => {
  const n = round2(num(signed));
  if (n === 0) return "0.00";
  return `${Math.abs(n).toFixed(2)} ${modeOf(n)}`;
};

/** The heading a printed sheet carries. */
export const bookTitle = (kind, accountName, groupName) => {
  const name = BOOK_NAMES[text(kind)] || BOOK_NAMES.ledger;
  if (groupName) return `${name} -- ${text(groupName)}`;
  return accountName ? `${name} -- ${text(accountName)}` : name;
};

/** The date line under the heading. */
export const periodText = (from, to, formatDate) => {
  const fmt = typeof formatDate === "function" ? formatDate : (d) => d.toISOString().slice(0, 10);
  const a = asDate(from);
  const b = asDate(to);
  if (a && b) return `${fmt(a)} to ${fmt(b)}`;
  if (a) return `from ${fmt(a)}`;
  if (b) return `up to ${fmt(b)}`;
  return "all dates";
};

/**
 * The balance as the screen shows it: the amount, with Dr/Cr beside it.
 * Exported signed it read "-1500, Cr".
 */
const balanceMagnitude = (row) =>
  row?.balance === "" || row?.balance === null || row?.balance === undefined
    ? row?.balance
    : Math.abs(Number(row.balance) || 0);

/** The columns a book downloads as. */
export const CSV_COLUMNS = {
  entries: [
    { key: "date", label: "Date" },
    { key: "particulars", label: "Particulars" },
    { key: "narration", label: "Narration" },
    { key: "debit", label: "Debit" },
    { key: "credit", label: "Credit" },
    { key: "balance", label: "Balance", value: balanceMagnitude },
    { key: "mode", label: "Dr/Cr" },
  ],
  daywise: [
    { key: "date", label: "Date" },
    { key: "entries", label: "Entries" },
    { key: "debit", label: "Debit" },
    { key: "credit", label: "Credit" },
    { key: "balance", label: "Balance", value: balanceMagnitude },
    { key: "mode", label: "Dr/Cr" },
  ],
};

/**
 * The same two column sets, with the TYPE and WIDTH the .xlsx writer needs.
 *
 * A separate constant rather than extra keys on CSV_COLUMNS, because the CSV
 * writer ignores both and several callers (and their tests) compare that
 * object. The labels are taken FROM CSV_COLUMNS rather than retyped, so the
 * download and the workbook cannot end up calling a column two things --
 * which is exactly the drift the comment on lib/salesReports.mjs's
 * CSV_COLUMNS was written about after it happened there.
 */
const SHEET_TYPES = {
  date: { type: "date", width: 12 },
  particulars: { type: "text", width: 26 },
  narration: { type: "text", width: 34 },
  entries: { type: "int", width: 10 },
  debit: { type: "money", width: 14 },
  credit: { type: "money", width: 14 },
  balance: { type: "money", width: 14 },
  mode: { type: "text", width: 7 },
};

export const SHEET_COLUMNS = Object.fromEntries(
  Object.entries(CSV_COLUMNS).map(([view, columns]) => [
    view,
    columns.map((column) => ({ ...column, ...(SHEET_TYPES[column.key] || { type: "text" }) })),
  ])
);

/**
 * The worksheets one book downloads as.
 *
 * Entry by entry first, with the day summary beside it when the screen asked
 * for one -- the CSV takes the first sheet, so a download matches whichever
 * table is being looked at. Built here rather than on the route so the
 * headings, the opening row and the totals come from the module that computed
 * them.
 *
 * THE OPENING BALANCE IS A ROW IN THE SHEET. A running-balance column whose
 * first figure comes from nowhere is a column nobody can check, and a
 * download is read without the screen's summary cards beside it.
 */
export const bookSheets = ({ book, kind, groupName = "", meta = [], daywise = false } = {}) => {
  if (!book) return [];

  // `book.group` is the account's GROUP FIELD as typed in the master, not the
  // group a group-wise book was run for -- passing it to `bookTitle` would
  // head a single account's cash book "Cash Book -- cash". The caller says
  // which it is, exactly as the screen does.
  const heading = bookTitle(kind, groupName ? "" : book.account, groupName);

  const openingRow = {
    date: book.from || null,
    particulars: "Opening balance",
    narration: "",
    debit: "",
    credit: "",
    balance: book.opening,
    mode: book.openingMode,
  };

  const entries = {
    name: heading || "Book",
    title: heading,
    meta,
    columns: SHEET_COLUMNS.entries,
    rows: [openingRow, ...(book.lines || [])],
    totals: {
      debit: book.totals?.debit ?? 0,
      credit: book.totals?.credit ?? 0,
      balance: Math.abs(Number(book.closing) || 0),
      mode: book.closingMode,
    },
    totalsLabel: "Period total",
  };

  if (!daywise || !book.daywise) return [entries];

  const days = {
    name: "Day by day",
    title: `${heading} -- day by day`,
    meta,
    columns: SHEET_COLUMNS.daywise,
    rows: book.daywise,
    totals: {
      debit: book.totals?.debit ?? 0,
      credit: book.totals?.credit ?? 0,
      balance: Math.abs(Number(book.closing) || 0),
      mode: book.closingMode,
    },
    totalsLabel: "Period total",
  };

  // Whichever view the screen is showing goes first, because the CSV is the
  // first sheet.
  return [days, entries];
};

/**
 * A download file name that says what it is and when it was taken.
 *
 * The account name goes in, lowercased and with anything awkward replaced:
 * a party called "Acme Traders, Delhi (HO)" would otherwise produce a file
 * name a browser quietly mangles or refuses.
 */
export const bookFilename = (kind, accountName, now = Date.now()) => {
  const stamp = new Date(now).toISOString().slice(0, 10);
  const who = text(accountName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const book = BOOK_KINDS.includes(text(kind)) ? text(kind) : "ledger";
  return who ? `${book}-book-${who}-${stamp}.csv` : `${book}-book-${stamp}.csv`;
};

/**
 * What is wrong with the request, in words. [] when it can be run.
 *
 * The date check is the one worth having: a range typed backwards returns
 * nothing at all, which looks exactly like an account with no entries.
 */
export const bookProblems = ({ kind, account, from, to } = {}) => {
  const problems = [];

  if (!isBookKind(kind)) problems.push("Pick a book.");
  if (!text(account)) problems.push("Pick an account.");

  const a = istDayNumber(from);
  const b = istDayNumber(to);
  if (from && a === null) problems.push("That start date is not valid.");
  if (to && b === null) problems.push("That end date is not valid.");
  // A range typed backwards returns nothing at all, which looks exactly like
  // an account that has had no entries.
  if (a !== null && b !== null && a > b) {
    problems.push("The start date is after the end date.");
  }

  return problems;
};
