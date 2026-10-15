/**
 * A report's filters, as a URL anyone can bookmark or send -- and back.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/report-query.test.mjs directly. Never import Mongoose in here.
 *
 *
 * WHY ONE MODULE
 * --------------
 * The statement and the account books already read a deep link
 * (components/StatementSearchParams.jsx, components/AccountBookSearchParams.jsx),
 * each with its own small reader and neither writing the URL back -- so a
 * filter changed on screen was gone the moment the page was shared. Every
 * other report read nothing. Writing a reader and a writer per page is how
 * the two drift: a key written as `party` and read as `customer`.
 *
 * So each report states its filters ONCE, as a schema, and both directions
 * come from it:
 *
 *   parseReportQuery(schema, params)   URL -> the filters it validly names
 *   buildReportQuery(schema, values)   filters -> the canonical query string
 *
 * WHAT A SHARED LINK GUARANTEES
 * -----------------------------
 *   - Every value is checked against the module that owns it. A URL is typed
 *     by people; `view=pdf` or `from=2026-02-31` is dropped and the page keeps
 *     its own default for that filter, rather than drawing a blank screen.
 *   - A filter at its default is left out, so a page with nothing chosen has a
 *     clean URL, and "clearing" a filter -- setting it back -- clears it from
 *     the address bar too.
 *   - DATES ARE ALWAYS WRITTEN where a report has them, defaults included.
 *     A report's default range is relative to TODAY ("this month"), so a link
 *     that left them out would reopen on the recipient's month, not the
 *     sender's. A shared report has to show the same period it was sent with.
 *   - A preset is written as the preset (`preset=prevQuarter`), and its dates
 *     only for Custom: the thirteen presets keep their meaning -- resolved by
 *     lib/reportPeriods.mjs, in IST -- instead of being frozen into dates.
 *   - The order of keys is the schema's, so the same filters always produce
 *     the same string, and the page can compare strings to know whether the
 *     URL needs touching at all.
 */

import { ALL_PRESETS } from "./reportPeriods.mjs";
import { BOOK_GRAINS, DOC_SCOPES, REPORT_SIDES, SALES_VIEWS } from "./salesReports.mjs";
import { RETURN_KEYS } from "./gstReturns.mjs";
import { STATEMENT_KINDS } from "./financials.mjs";
import { ORDER_TYPES } from "./orderStatus.mjs";
import { BOOK_KINDS } from "./accountBooks.mjs";
import { STATEMENT_FORMATS, STATEMENT_SIDES } from "./statements.mjs";
import { MOVEMENT_TYPE_KEYS, SUMMARY_STATUSES } from "./inventoryReports.mjs";

const text = (value) => String(value ?? "").trim();

/** Longest free-text filter a URL may carry: a party or item name. */
export const MAX_TEXT = 120;

/** A real calendar day, as yyyy-mm-dd. "2026-02-31" is not one. */
export const isIsoDate = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999) return false;
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
};

/** A month, as yyyy-mm -- the sales book's zoom. */
export const isIsoMonth = (value) => {
  const m = /^(\d{4})-(\d{2})$/.exec(text(value));
  return Boolean(m) && Number(m[2]) >= 1 && Number(m[2]) <= 12;
};

/**
 * A decimal, as a number box can hold it -- exponent included, because a
 * `type="number"` input accepts "1e5" and the route reads it with Number().
 * A figure the route would take must not be silently left out of the link.
 */
const isDecimal = (value) => /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text(value));

/**
 * Is `raw` a valid value for this field? Returns the value to use, or
 * `undefined` when it is not valid (and the page keeps its own).
 */
const accept = (field, raw) => {
  const value = text(raw);
  if (value === "") return field.blank ? "" : undefined;
  switch (field.type) {
    case "enum":
      return field.values.includes(value) ? value : undefined;
    case "date":
      return isIsoDate(value) ? value : undefined;
    case "month":
      return isIsoMonth(value) ? value : undefined;
    case "text":
      return value.length <= (field.max || MAX_TEXT) ? value : undefined;
    case "bool":
      return value === "1" || value === "true" ? true : value === "0" || value === "false" ? false : undefined;
    case "decimal":
      return isDecimal(value) ? value : undefined;
    default:
      return undefined;
  }
};

/** The value as it goes into the URL. */
const encode = (field, value) => {
  if (field.type === "bool") return value ? "1" : "0";
  return text(value);
};

/** Is this value the field's default -- and so left out of the URL? */
const isDefault = (field, value) => {
  if (field.always) return false;
  if (field.type === "bool") return Boolean(value) === Boolean(field.default);
  return text(value) === text(field.default ?? "");
};

/**
 * The filters a URL validly names.
 *
 * Returns `{ values, invalid, present }`:
 *   values   only the keys that were present AND valid -- the page applies
 *            these and keeps its own state for everything else
 *   invalid  the keys that were present but not valid, for a notice or a test
 *   present  whether the URL named any filter at all
 *
 * `params` is anything with `get(name)` -- URLSearchParams, Next's
 * ReadonlyURLSearchParams -- or a plain object, or a query string.
 */
export const parseReportQuery = (schema = {}, params = null) => {
  const get = toGetter(params);
  const values = {};
  const invalid = [];
  let present = false;

  for (const [key, field] of Object.entries(schema)) {
    const raw = get(field.param || key);
    if (raw === null || raw === undefined) continue;
    present = true;
    const value = accept(field, raw);
    if (value === undefined) invalid.push(key);
    else values[key] = value;
  }
  return { values, invalid, present };
};

/**
 * The canonical query string for these filters, without the leading `?`.
 *
 * Keys in schema order; defaults left out unless `always`; a field with a
 * `when(values)` only when it applies (a custom range's dates). An invalid or
 * missing value is left out rather than written -- the writer never puts in
 * the URL something the reader would refuse.
 */
export const buildReportQuery = (schema = {}, values = {}) => {
  const params = new URLSearchParams();
  for (const [key, field] of Object.entries(schema)) {
    if (typeof field.when === "function" && !field.when(values)) continue;
    const value = values?.[key];
    if (value === undefined || value === null) continue;
    if (field.type !== "bool" && accept(field, value) === undefined) continue;
    if (field.type !== "bool" && text(value) === "" && !field.blank) continue;
    if (isDefault(field, value)) continue;
    params.set(field.param || key, encode(field, value));
  }
  return params.toString();
};

/** The same filters, the same string -- whatever order they arrived in. */
export const sameQuery = (a, b) => {
  const norm = (q) => {
    const p = new URLSearchParams(text(q).replace(/^\?/, ""));
    return [...p.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  };
  return norm(a) === norm(b);
};

function toGetter(params) {
  if (!params) return () => null;
  if (typeof params === "string") {
    const p = new URLSearchParams(params.replace(/^\?/, ""));
    return (k) => p.get(k);
  }
  if (typeof params.get === "function") return (k) => params.get(k);
  return (k) => (Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null);
}

/* ─────────────────────────────── the reports ───────────────────────────── */

const isCustom = (values) => text(values?.preset) === "custom";

/**
 * Every report's filters. The keys are the ones each report's own route
 * already takes, so a deep link and an API call read the same; where a page
 * already read a different name from the URL (the order report's `customer`),
 * that name is kept with `param` so existing links keep working.
 */
export const REPORT_QUERIES = {
  // Sales book, party-wise, item-wise -- and the purchase side.
  salesReport: {
    side: { type: "enum", values: REPORT_SIDES, default: "Sale" },
    view: { type: "enum", values: SALES_VIEWS, default: "book" },
    scope: { type: "enum", values: DOC_SCOPES, default: "both" },
    grain: { type: "enum", values: BOOK_GRAINS, default: "month" },
    // The period and item rows, split one per party. A filter like any
    // other, so a party-wise book that is sent opens party-wise.
    //
    // ON BY DEFAULT. A book grouped by month is one row per month and names
    // nobody, which is the first thing anybody asks of it -- "who was that".
    // The toggle turns it off for the plain period totals, and because this
    // IS the default, that choice is the one that ends up in the URL
    // (`isDefault` leaves a value matching the default out), so a plain book
    // that is shared opens plain.
    byparty: { type: "bool", default: true },
    // The zoom into a month's dates. A position in the book, but one a
    // shared link should land on all the same.
    month: { type: "month", default: "" },
    // Blank is allowed: the route reads an empty bound as "no limit".
    from: { type: "date", always: true, blank: true },
    to: { type: "date", always: true, blank: true },
  },

  gstReturn: {
    view: { type: "enum", values: RETURN_KEYS, default: "gstr1" },
    // Both required by the route, so never blank.
    from: { type: "date", always: true },
    to: { type: "date", always: true },
  },

  financials: {
    kind: { type: "enum", values: STATEMENT_KINDS, default: "trial" },
    from: { type: "date", always: true },
    to: { type: "date", always: true },
    expand: { type: "bool", default: false },
    // Typed-in stock figures override the valuation; they change every
    // statement, so they are filters like any other.
    closingStock: { type: "decimal", default: "" },
    openingStock: { type: "decimal", default: "" },
  },

  orderReport: {
    type: { type: "enum", values: ORDER_TYPES, default: "Sale" },
    view: { type: "enum", values: ["register", "party-pending", "item-pending", "reconcile"], default: "register" },
    // Only the register is a date-range report (the page's own rule).
    from: { type: "date", always: true, when: (v) => text(v?.view || "register") === "register" },
    to: { type: "date", always: true, when: (v) => text(v?.view || "register") === "register" },
    // `customer` is the name the page has always read from a link.
    party: { type: "text", param: "customer", default: "" },
    item: { type: "text", default: "" },
  },

  // The two that already read a link. Their keys are unchanged; what is new
  // is that the URL now follows the filters on screen.
  statement: {
    side: { type: "enum", values: Object.keys(STATEMENT_SIDES), default: "customer" },
    account: { type: "text", default: "" },
    view: { type: "enum", values: STATEMENT_FORMATS, default: "detailed" },
    preset: { type: "enum", values: ALL_PRESETS, default: "thisFy" },
    from: { type: "date", always: true, when: isCustom },
    to: { type: "date", always: true, when: isCustom },
  },

  // Stock summary, movement history and valuation (app/stock-report).
  stockReport: {
    view: { type: "enum", values: ["summary", "movements", "valuation"], default: "summary" },
    preset: { type: "enum", values: ALL_PRESETS, default: "thisMonth" },
    from: { type: "date", always: true, when: isCustom },
    to: { type: "date", always: true, when: isCustom },
    q: { type: "text", default: "" },
    item: { type: "text", default: "" },
    type: { type: "enum", values: MOVEMENT_TYPE_KEYS, default: "" },
    ref: { type: "text", default: "" },
    status: { type: "enum", values: SUMMARY_STATUSES, default: "all" },
  },

  accountBook: {
    kind: { type: "enum", values: BOOK_KINDS, default: "cash" },
    account: { type: "text", default: "" },
    group: { type: "text", default: "" },
    preset: { type: "enum", values: ALL_PRESETS, default: "thisFy" },
    from: { type: "date", always: true, when: isCustom },
    to: { type: "date", always: true, when: isCustom },
    daywise: { type: "bool", default: false },
  },
};
