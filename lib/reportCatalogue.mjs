/**
 * Every report this app has, in categories.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/report-catalogue.test.mjs directly.
 *
 *
 * WHY A LIST RATHER THAN A PAGE FULL OF TILES
 * -------------------------------------------
 * The home screen grew a flat Reports section one tile at a time, which is
 * how a shop ends up with "Sales & Purchase", "Business Dashboard", "GST
 * Returns", "Trial Balance", "Cash / Bank Book" and two ledger pickers in one
 * column with no indication that four of them are the same kind of thing.
 *
 * Holding the list here instead means the hub page is a loop, the permission
 * each report needs is read from lib/roles.mjs rather than typed again beside
 * the tile, and a test can assert that every `path` in it is a page that
 * exists and that every report names a permission the roles table agrees
 * with. A tile with a typo'd path is a dead end nobody notices until a
 * customer finds it.
 *
 *
 * EVERY ENTRY IS A REPORT THAT ALREADY EXISTS
 * -------------------------------------------
 * Deliberately: the brief was to unify the reporting experience, not to
 * invent reports. Where a category has nothing behind it yet, the category
 * says so (`REPORT_GAPS`) rather than carrying a tile that opens an empty
 * page -- an honest gap is more use than a link to nothing.
 */

const text = (value) => String(value ?? "").trim();

/**
 * The categories, in the order the hub shows them.
 *
 * Ordered by how often a trading firm reaches for them, not alphabetically:
 * statements and party ledgers are the daily work, the statutory returns are
 * monthly, the final accounts are yearly.
 */
export const REPORT_CATEGORIES = [
  { key: "statements", label: "Statements", blurb: "What a party owes, on a sheet you can send them." },
  { key: "party", label: "Party ledgers", blurb: "One account's history, with its opening and closing." },
  { key: "sales", label: "Sales", blurb: "What was invoiced, to whom, and of what." },
  { key: "purchase", label: "Purchases", blurb: "What was billed to the firm, by whom." },
  { key: "money", label: "Receipts & payments", blurb: "Money in and out, by account and by day." },
  { key: "inventory", label: "Inventory", blurb: "What moved, and what is on the shelf." },
  { key: "tax", label: "Tax & GST", blurb: "The returns, from the invoices already raised." },
  { key: "accounts", label: "Final accounts", blurb: "The firm's position, for the year." },
  { key: "analytics", label: "Analytics", blurb: "Trends and comparisons, over the books." },
];

export const CATEGORY_KEYS = REPORT_CATEGORIES.map((c) => c.key);

/**
 * The reports.
 *
 * `path`        the page, exactly as lib/roles.mjs spells it
 * `category`    one of CATEGORY_KEYS
 * `name`        what it is called on the tile
 * `blurb`       one line: what question it answers
 * `exports`     which download formats it offers, [] for none yet
 * `period`      does it take a date range at all? A balance sheet does; a
 *               current-stock list does not, and saying so on the tile is
 *               what stops somebody filtering a position by a date range and
 *               believing the answer (see lib/dashboard.mjs's POINT_IN_TIME).
 */
export const REPORTS = [
  {
    key: "customer-statement",
    category: "statements",
    name: "Customer statement",
    path: "/statement",
    query: { side: "customer" },
    blurb: "A customer's opening balance, the period's invoices, returns and receipts, and what is still owed.",
    exports: ["csv", "xlsx"],
    period: true,
    print: true,
  },
  {
    key: "supplier-statement",
    category: "statements",
    name: "Supplier statement",
    path: "/statement",
    query: { side: "supplier" },
    blurb: "The same sheet for a supplier: bills, returns, payments, and what the firm still owes.",
    exports: ["csv", "xlsx"],
    period: true,
    print: true,
  },
  {
    key: "ac-ledger",
    category: "party",
    name: "A/C Ledger",
    path: "/account-book",
    query: { kind: "ledger" },
    blurb: "Any account's book for a date range, with a recomputed running balance. Also group-wise.",
    exports: ["csv", "xlsx"],
    period: true,
    print: true,
  },
  {
    key: "customer-ledger",
    category: "party",
    name: "Customer ledger",
    path: "/ledger",
    blurb: "The older per-customer ledger, reached from the home screen's picker.",
    exports: [],
    period: true,
    print: true,
  },
  {
    key: "sales-book",
    category: "sales",
    name: "Sales book, party-wise, item-wise",
    path: "/sales-report",
    blurb: "Sigfa's Sales module: the book at month or date grain, totals by party, totals by item.",
    exports: ["csv"],
    period: true,
    print: true,
  },
  {
    key: "sales-orders",
    category: "sales",
    name: "Pending sales orders",
    path: "/order-report",
    blurb: "Party-wise and item-wise pending orders, with the quantity still to bill and current stock.",
    exports: ["csv"],
    period: true,
    print: true,
  },
  {
    key: "purchase-book",
    category: "purchase",
    name: "Purchase book, party-wise, item-wise",
    path: "/sales-report",
    blurb: "The same three sheets on the purchase side -- one switch on the report.",
    exports: ["csv"],
    period: true,
    print: true,
  },
  {
    key: "cash-book",
    category: "money",
    name: "Cash book",
    path: "/account-book",
    query: { kind: "cash" },
    blurb: "Every cash entry for a range, entry by entry or one line per day.",
    exports: ["csv", "xlsx"],
    period: true,
    print: true,
  },
  {
    key: "bank-book",
    category: "money",
    name: "Bank book",
    path: "/account-book",
    query: { kind: "bank" },
    blurb: "The same for each bank account, overdrafts included.",
    exports: ["csv", "xlsx"],
    period: true,
    print: true,
  },
  {
    key: "voucher-register",
    category: "money",
    name: "Voucher register",
    path: "/voucher",
    blurb: "Receipts and payments as entered, with the bills each was set against.",
    exports: [],
    period: true,
    print: true,
  },
  {
    key: "stock-ledger",
    category: "inventory",
    name: "Stock ledger",
    path: "/item-ledger",
    blurb: "One item's receipts and issues in date order, with its running quantity.",
    exports: [],
    period: true,
    print: true,
  },
  {
    key: "gst-returns",
    category: "tax",
    name: "GSTR-1, GSTR-3, GSTR-3B",
    path: "/gst-return",
    blurb: "The three returns and the GSTR-1 portal JSON, built from the invoices already raised.",
    exports: ["csv", "json"],
    period: true,
    print: true,
  },
  {
    key: "financials",
    category: "accounts",
    name: "Trial balance & final accounts",
    path: "/financials",
    blurb: "Trial balance, trading account, profit & loss and balance sheet.",
    exports: ["csv"],
    period: true,
    print: true,
  },
  {
    key: "dashboard",
    category: "analytics",
    name: "Business dashboard",
    path: "/dashboard",
    blurb: "Sales trends, receivables, payables, low stock and month-on-month comparison.",
    exports: [],
    period: true,
    print: false,
  },
];

/**
 * What a category has NOT got yet, said plainly on the hub.
 *
 * The brief asks for inventory valuation and movement-history reports and for
 * a receipts/payments summary that this app does not have; a tile linking to
 * a page that does not exist is worse than a sentence saying so. Each line is
 * removed when the report lands, and a test checks none of them names a path
 * that now exists.
 */
export const REPORT_GAPS = {
  inventory: [
    "Stock summary, valuation and a low-stock short list are specified and not built yet. Current stock per item is on the dashboard in the meantime.",
  ],
  money: [
    "There is no single receipts-and-payments summary across all cash and bank accounts; the cash book and bank book cover one account at a time.",
  ],
};

export const reportsIn = (category) =>
  REPORTS.filter((r) => r.category === text(category));

/** The href a tile opens, with its preselecting query if it has one. */
export const reportHref = (report) => {
  const path = text(report?.path);
  if (!path) return "";
  const entries = Object.entries(report?.query || {}).filter(([, v]) => text(v));
  if (!entries.length) return path;
  const params = new URLSearchParams(entries.map(([k, v]) => [k, text(v)]));
  return `${path}?${params.toString()}`;
};

/**
 * The hub, grouped and filtered to what this role may open.
 *
 * `allowed` is a predicate -- in practice `(path) => canAccessPath(role,
 * path)` from lib/roles.mjs, passed in rather than imported so this module
 * stays a list and the permission rules stay in the one file that owns them.
 *
 * A report the role cannot open is RETURNED, flagged `locked`, rather than
 * dropped. A biller who cannot see the ledger should be told the report
 * exists and is not theirs, not left wondering whether the firm has one --
 * which is the question they would otherwise ask the owner.
 */
export const reportHub = ({ allowed = () => true } = {}) =>
  REPORT_CATEGORIES.map((category) => ({
    ...category,
    gaps: REPORT_GAPS[category.key] || [],
    reports: reportsIn(category.key).map((report) => ({
      ...report,
      href: reportHref(report),
      locked: !allowed(report.path),
    })),
  })).filter((category) => category.reports.length || category.gaps.length);
