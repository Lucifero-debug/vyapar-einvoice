/**
 * "You have orders dated today" — the rule, and the once-a-day dismissal.
 *
 * `orderDate` is the date on the customer's or supplier's order, typed on the
 * billing form beside the order number. It is not the invoice date, and it is
 * the one date on an invoice that nothing in the app ever surfaced again, so a
 * bill raised against an order dated today was invisible the moment it was
 * saved.
 *
 * WHAT COUNTS
 *
 * A Sale or a Purchase whose `orderDate` falls on today's IST calendar day.
 * Returns are excluded: a credit note rarely carries a meaningful order date,
 * and when it does it is the original order's, which would surface the same
 * order twice.
 *
 * WHY IST AND NOT THE MACHINE'S CLOCK
 *
 * At 2am on the 9th in Delhi it is still the 8th in UTC, and the shopkeeper
 * means the 9th. The dates themselves are stored as UTC midnight of the day
 * somebody picked, which always falls inside the IST window for that same
 * day -- so one rule reads both correctly. lib/istDate.mjs.
 *
 * Pure, so the route, the popup and a bare `node` test share one definition.
 */

import { istDayNumber } from "./istDate.mjs";

/** Document types whose order date is worth a reminder. */
export const ORDER_TYPES = ["Sale", "Purchase"];

/** How many to name in the popup before it just says "and N more". */
export const MAX_LISTED = 8;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** Is this a document whose order date we would ever mention? */
export const isOrderType = (invoice) =>
  ORDER_TYPES.includes(text(invoice?.type)) && invoice?.return !== true;

/**
 * Does this invoice carry an order dated on the same IST day as `now`?
 *
 * `now` is a parameter so "today" is testable without waiting for tomorrow.
 */
export const isTodaysOrder = (invoice, now = Date.now()) => {
  if (!isOrderType(invoice)) return false;
  const day = istDayNumber(invoice?.orderDate);
  if (day === null) return false;
  return day === istDayNumber(now);
};

/** The ones worth showing, newest invoice first. */
export const todaysOrders = (invoices = [], now = Date.now()) =>
  (invoices || [])
    .filter((i) => isTodaysOrder(i, now))
    .sort((a, b) => Number(b?.invoiceNo || 0) - Number(a?.invoiceNo || 0));

/**
 * One line per order, as the popup shows it. Built here rather than in the
 * component so the wording is testable and the same everywhere.
 */
export const orderLine = (invoice) => ({
  invoiceNo: invoice?.invoiceNo ?? null,
  type: text(invoice?.type),
  party: text(invoice?.customer?.name) || "No party",
  orderNo: text(invoice?.orderNo),
  amount: Number(invoice?.finalAmount) || 0,
});

/**
 * What the popup says at the top. Singular and plural both read properly --
 * "1 orders" on a shopkeeper's screen looks like a broken app.
 */
export const headline = (count) => {
  if (count <= 0) return "";
  return count === 1 ? "1 order is dated today" : `${count} orders are dated today`;
};

/* ------------------------------------------------------- once a day only -- */

/**
 * The localStorage key for today's dismissal.
 *
 * The IST day is in the key, so tomorrow's popup is a different key and
 * appears without anything having to expire or be cleaned up. Dismissing is
 * per browser, which is the right grain: it is a nudge, not a task list.
 */
export const DISMISS_PREFIX = "vyapaar:todaysOrders:";

export const dismissKey = (now = Date.now()) => {
  const day = istDayNumber(now);
  return day === null ? null : `${DISMISS_PREFIX}${day}`;
};

/**
 * Should the popup be shown at all?
 *
 * `read` is the storage getter, passed in so this stays pure and so a browser
 * that throws on localStorage (private windows do) cannot take the page down
 * with it.
 */
export const shouldShow = ({ count, now = Date.now(), read } = {}) => {
  if (!count || count <= 0) return false;
  const key = dismissKey(now);
  if (!key) return false;
  try {
    return read?.(key) ? false : true;
  } catch {
    // Storage unavailable: show it. A nudge shown twice beats one never shown.
    return true;
  }
};
