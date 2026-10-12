/**
 * The order reports: the register, party-wise pending, item-wise pending, and
 * the reconciliation that checks the stored counter against the invoices.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture test directly. Never import Mongoose in here. All the fulfilment
 * arithmetic comes from lib/orderStatus.mjs -- this module only groups, ages
 * and serialises.
 *
 * WHAT THE LIVE SIGFA DATA SETTLED
 * --------------------------------
 * Three things, each of which would have been guessed wrong:
 *
 *   1. THE PROMISED DATE IS ON THE LINE, NOT THE HEADER. In 212 live orders
 *      the header's DESPDATE is filled 0 times and DAYS is set 0 times, while
 *      the line's DESPDATE is filled on 529 of 702 lines (75%). Ageing a
 *      pending report off the header would leave the due-date column empty
 *      for every real order. So `promisedOn` below reads the LINE first and
 *      falls back to the header.
 *
 *   2. THE GROUPS ARE BIG. 130 parties and 588 distinct items across those
 *      212 orders, with 89 lines against one single party. A flat list is not
 *      a report at that size: both pending views group, total, and sort by
 *      value descending so the biggest exposure is on top.
 *
 *   3. THE DELIVERY WINDOW AND SCHEDULES ARE DEAD. FMDATE, TODATE and SCHD
 *      are empty on all 702 lines, which is why neither exists here.
 *
 * Nothing in this module has a notion of tax, because an order has none.
 */

import {
  ORDER_TYPES,
  QTY_EPSILON,
  cancelledQty,
  invoicedQty,
  isOrderType,
  lineTotal,
  orderStatus,
  orderedQty,
  pendingQty,
  roundQty,
  trim,
} from "./orderStatus.mjs";

const round2 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const text = (value) => String(value ?? "").trim();

/** A date, or null. Accepts what Mongo returns and what a form posts. */
const asDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const REPORTS = [
  "register",
  "party-pending",
  "item-pending",
  "reconcile",
];

// ── dates and ageing ──────────────────────────────────────────────────────

/**
 * When this line was promised: its own date, else the order's.
 *
 * The line first, on the evidence above. A line with neither is not overdue
 * and must not be guessed into being so -- an order with no agreed date is
 * not late, it is just open.
 */
export const promisedOn = (order, line) =>
  asDate(line?.deliveryDate) || asDate(order?.deliveryDate) || null;

/**
 * Days late, or null when nothing was promised. Negative is not returned:
 * a line due next week is not "-7 overdue", it is simply not overdue.
 */
export const daysOverdue = (order, line, now = Date.now()) => {
  const due = promisedOn(order, line);
  if (!due) return null;
  // Math.max rather than `days > 0 ? days : 0`: the two are identical,
  // because the false branch is also 0, and mutation testing could not tell
  // them apart. One expression says the intent without implying that the
  // boundary is a decision.
  return Math.max(0, Math.floor((now - due.getTime()) / 86400000));
};

export const isOverdue = (order, line, now = Date.now()) =>
  (daysOverdue(order, line, now) || 0) > 0;

/**
 * The ageing bucket a pending line falls in, by order date.
 *
 * Buckets rather than a raw age because that is how a chase list is read --
 * "what has been sitting more than three months" is the question, not "how
 * many days exactly". The boundaries follow the receivables ageing this app
 * already shows elsewhere.
 */
export const AGEING_BUCKETS = ["0-30", "31-60", "61-90", "90+"];

export const ageingBucket = (order, now = Date.now()) => {
  const date = asDate(order?.date);
  if (!date) return "0-30";
  const days = Math.floor((now - date.getTime()) / 86400000);
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
};

// ── the register: one row per order ───────────────────────────────────────

/**
 * The sales or purchase order register.
 *
 * One row per order with its derived status, what is still to bill, and
 * whether anything on it is late. `status` is recomputed from the lines
 * rather than read off the stored column, so a column that has drifted shows
 * the truth on screen.
 */
export const registerRows = (orders, now = Date.now()) =>
  (orders || [])
    .filter(Boolean)
    .map((order) => {
      const lines = (order.items || []).filter(Boolean);
      const pending = lines.filter((l) => pendingQty(l) > QTY_EPSILON);
      const late = pending.filter((l) => isOverdue(order, l, now));
      return {
        orderNo: num(order.orderNo),
        type: text(order.type),
        date: asDate(order.date),
        party: text(order.customer?.name),
        reference: text(order.reference),
        deliveryDate: asDate(order.deliveryDate),
        status: orderStatus(order),
        hold: Boolean(order.hold),
        lineCount: lines.length,
        pendingCount: pending.length,
        orderValue: round2(
          lines.reduce((sum, l) => sum + lineTotal(l), 0)
        ),
        pendingValue: round2(
          pending.reduce(
            (sum, l) => sum + lineTotal({ ...l, quantity: pendingQty(l) }),
            0
          )
        ),
        overdueCount: late.length,
        oldestOverdue: late.reduce(
          (worst, l) => Math.max(worst, daysOverdue(order, l, now) || 0),
          0
        ),
        ageing: ageingBucket(order, now),
      };
    })
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0) || b.orderNo - a.orderNo);

// ── the two pending views ─────────────────────────────────────────────────

/**
 * Every pending line, flattened, with its order's context attached.
 *
 * The common input to both grouped reports. Held orders are included but
 * flagged: a report that silently omits them makes an order vanish, and
 * "why is this not on the pending list" is a worse question than "why is
 * this marked on hold".
 */
export const pendingLineRows = (orders, now = Date.now()) => {
  const rows = [];
  for (const order of (orders || []).filter(Boolean)) {
    for (const line of (order.items || []).filter(Boolean)) {
      const pending = pendingQty(line);
      if (pending <= QTY_EPSILON) continue;
      rows.push({
        orderNo: num(order.orderNo),
        type: text(order.type),
        orderDate: asDate(order.date),
        party: text(order.customer?.name),
        reference: text(order.reference),
        hold: Boolean(order.hold),
        item: text(line.name),
        hsn: text(line.hsn),
        uqc: text(line.uqc),
        ordered: orderedQty(line),
        billed: invoicedQty(line),
        cancelled: cancelledQty(line),
        pending,
        rate: num(line.cost),
        discount: num(line.discount),
        value: round2(lineTotal({ ...line, quantity: pending })),
        promised: promisedOn(order, line),
        overdueDays: daysOverdue(order, line, now),
        ageing: ageingBucket(order, now),
      });
    }
  }
  return rows;
};

/**
 * Group pending lines by one key, total them, and sort by value descending.
 *
 * Shared by both views because the only difference between "party-wise" and
 * "item-wise" is which field the key comes from -- writing it twice is how
 * the two reports end up disagreeing about what "pending" means.
 */
const groupBy = (rows, keyOf, label) => {
  const groups = new Map();

  for (const row of rows) {
    const key = keyOf(row) || "(not named)";
    if (!groups.has(key)) {
      groups.set(key, {
        [label]: key,
        lines: [],
        orders: new Set(),
        // === Sigfa's three quantity columns ===
        //
        // ORDER.QTY is the order quantity as it stands NOW -- what was
        // ordered, less anything cancelled since. Not the figure originally
        // typed.
        //
        // That is deliberate, and it is what makes the row add up. Sigfa
        // prints BALANCE = ORDER.QTY - DESP QTY., and its cancellation works
        // by amending the order quantity itself, so the subtraction always
        // holds on its sheets. Here a cancelled quantity is held separately
        // (lib/orderStatus.mjs: pending = ordered - cancelled - billed), so
        // printing the ORIGINAL ordered figure would give rows where
        // 500 - 200 came to 250 and nothing on the page explained the gap.
        //
        // Netting the cancellation into ORDER.QTY restores the identity
        // exactly: orderQty - despQty === balance, for every row, always.
        orderQty: 0,
        despQty: 0,
        cancelledQty: 0,
        pendingQty: 0,
        pendingValue: 0,
        overdueLines: 0,
        oldestOverdue: 0,
        onHold: 0,
        // The unit, for Sigfa's UNIT column. Taken from the first line that
        // names one; `units` keeps the rest, because one item billed in two
        // units is a master-data problem the report should not hide behind a
        // single heading.
        unit: "",
        units: new Set(),
      });
    }
    const g = groups.get(key);
    g.lines.push(row);
    g.orders.add(`${row.type}#${row.orderNo}`);
    g.orderQty = roundQty(g.orderQty + row.ordered - row.cancelled);
    g.despQty = roundQty(g.despQty + row.billed);
    g.cancelledQty = roundQty(g.cancelledQty + row.cancelled);
    if (row.uqc) {
      g.units.add(row.uqc);
      if (!g.unit) g.unit = row.uqc;
    }
    g.pendingQty = roundQty(g.pendingQty + row.pending);
    g.pendingValue = round2(g.pendingValue + row.value);
    if ((row.overdueDays || 0) > 0) {
      g.overdueLines += 1;
      g.oldestOverdue = Math.max(g.oldestOverdue, row.overdueDays);
    }
    if (row.hold) g.onHold += 1;
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      orderCount: g.orders.size,
      lineCount: g.lines.length,
      // A Set does not survive JSON, and the route sends this straight out.
      orders: [...g.orders],
      units: [...g.units],
      // Sigfa's BALANCE column. The same number as pendingQty -- named twice
      // on purpose, so the report can print Sigfa's heading without anything
      // downstream having to know that "balance" and "pending" are one thing.
      balance: g.pendingQty,
    }))
    .sort((a, b) => b.pendingValue - a.pendingValue || String(a[label]).localeCompare(String(b[label])));
};

/**
 * The two groupings, over rows that have ALREADY been filtered.
 *
 * Exported separately because a filter has to be applied to the LINES, not
 * to the groups. Narrowing a party-wise report to one item by dropping
 * groups that do not mention it would leave each surviving group still
 * totalling all its other items -- a total that answers no question anyone
 * asked. Filter the rows, then group them.
 */
export const partyPendingFrom = (rows) => groupBy(rows || [], (r) => r.party, "party");
export const itemPendingFrom = (rows) => groupBy(rows || [], (r) => r.item, "item");

/** Party-wise pending orders: who is waiting for how much. */
export const partyPending = (orders, now = Date.now()) =>
  partyPendingFrom(pendingLineRows(orders, now));

/** Item-wise pending orders: how much of each item is still to move. */
export const itemPending = (orders, now = Date.now()) =>
  itemPendingFrom(pendingLineRows(orders, now));

/**
 * Put the stock on hand beside each item's pending quantity.
 *
 * The question the item-wise list is actually asked -- "we owe 400, have we
 * got them?" -- and without the second number the report answers only half of
 * it, leaving the reader to open the stock report and match names by eye.
 *
 * `stockOf` is a function from item name to quantity, so this stays pure:
 * the route supplies it from lib/itemStock.mjs, which sums the stock ledger
 * rather than trusting a cached balance.
 *
 * `shortBy` is floored at zero. A negative shortfall is just surplus, and
 * showing "-250 short" invites exactly the wrong reading on a list people
 * scan quickly.
 *
 * An item with no stock record at all gets `stock: null`, not 0. They are
 * different facts -- "none left" against "this item is not in the master" --
 * and the second is worth seeing, because it usually means the name on the
 * order does not match the name on the item.
 */
export const withStock = (groups = [], stockOf) => {
  const lookup = typeof stockOf === "function" ? stockOf : () => null;

  return groups.map((group) => {
    const found = lookup(group.item);
    const stock = found === null || found === undefined ? null : roundQty(found);
    const pending = roundQty(group.pendingQty);

    return {
      ...group,
      stock,
      known: stock !== null,
      shortBy: stock === null ? pending : Math.max(0, roundQty(pending - stock)),
      // A surplus is the same subtraction the other way, kept separate so
      // neither has to be read as a signed number.
      surplus: stock === null ? 0 : Math.max(0, roundQty(stock - pending)),
      covered: stock !== null && roundQty(stock - pending) >= 0,
    };
  });
};

/**
 * The totals strip above either grouped view.
 *
 * `rows` may be passed when the caller has already flattened and FILTERED
 * the lines, so the heading total describes the same set as the column
 * beneath it. Computed from the unfiltered orders instead, a report narrowed
 * to one item would show that item's rows under a total for the whole book.
 */
export const pendingSummary = (orders, now = Date.now(), rows = null) => {
  rows = rows || pendingLineRows(orders, now);
  const overdue = rows.filter((r) => (r.overdueDays || 0) > 0);
  const byBucket = {};
  for (const bucket of AGEING_BUCKETS) byBucket[bucket] = 0;
  for (const row of rows) byBucket[row.ageing] = round2(byBucket[row.ageing] + row.value);

  return {
    lines: rows.length,
    orders: new Set(rows.map((r) => `${r.type}#${r.orderNo}`)).size,
    parties: new Set(rows.map((r) => r.party)).size,
    items: new Set(rows.map((r) => r.item)).size,
    pendingValue: round2(rows.reduce((s, r) => s + r.value, 0)),
    overdueLines: overdue.length,
    overdueValue: round2(overdue.reduce((s, r) => s + r.value, 0)),
    byAgeing: byBucket,
  };
};

// ── reconciliation ────────────────────────────────────────────────────────

/**
 * Derive each order line's billed quantity from the INVOICE LINES, Sigfa's
 * way, and compare it against the stored `invoicedQty`.
 *
 * This is the check the stored counter needs and Sigfa's derived figure does
 * not. `save-invoice`, `sale-alter` and `delete-invoice` all move the counter
 * inside the invoice's own transaction, so the two should agree exactly --
 * but "should" is not "does", and the failure is silent: an order quietly
 * reports the wrong pending quantity for ever.
 *
 * Returns one entry per DISAGREEING line. An empty array is the whole point.
 *
 * Returns are excluded deliberately. A credit note's lines carry the same
 * order reference as the bill they reverse (that is how the form prefills
 * them), so counting them would subtract the quantity twice -- once here and
 * never in the counter, which only ever moved on the original sale.
 */
export const reconcileOrders = ({ orders, invoiceLines }) => {
  const billed = new Map();

  for (const line of (invoiceLines || []).filter(Boolean)) {
    if (line.isReturn) continue;
    const orderNo = num(line.orderNo);
    const type = text(line.orderType);
    const lineId = text(line.orderLineId);
    if (!orderNo || !isOrderType(type) || !lineId) continue;
    const key = `${type}#${orderNo}#${lineId}`;
    billed.set(key, roundQty((billed.get(key) || 0) + Math.max(0, num(line.quantity))));
  }

  const problems = [];
  const seen = new Set();

  for (const order of (orders || []).filter(Boolean)) {
    const type = text(order.type);
    const orderNo = num(order.orderNo);
    for (const line of (order.items || []).filter(Boolean)) {
      const lineId = text(line._id);
      if (!lineId) continue;
      const key = `${type}#${orderNo}#${lineId}`;
      seen.add(key);
      const stored = invoicedQty(line);
      const derived = roundQty(billed.get(key) || 0);
      if (Math.abs(stored - derived) <= QTY_EPSILON) continue;
      problems.push({
        type,
        orderNo,
        item: text(line.name),
        lineId,
        stored,
        derived,
        difference: roundQty(derived - stored),
        reason:
          derived > stored
            ? "Invoices bill more than the order records as billed."
            : "The order records more as billed than the invoices account for.",
      });
    }
  }

  // An invoice pointing at an order line that is not there at all. The claim
  // helper refuses this at save time, so it can only arise from a write that
  // went round it.
  for (const key of billed.keys()) {
    if (seen.has(key)) continue;
    const [type, orderNo, lineId] = key.split("#");
    problems.push({
      type,
      orderNo: num(orderNo),
      item: "",
      lineId,
      stored: 0,
      derived: roundQty(billed.get(key)),
      difference: roundQty(billed.get(key)),
      reason: "An invoice references an order line that no longer exists.",
    });
  }

  return problems.sort(
    (a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.orderNo - b.orderNo
  );
};

// ── what billed an order ──────────────────────────────────────────────────

/**
 * One row per invoice that touched this order, carrying only the lines that
 * belong to it.
 *
 * A bill usually carries other lines too -- freight, items ordered over the
 * counter, another order entirely -- so reporting its whole value against
 * this order would overstate what the order accounts for. Only the matching
 * lines are summed.
 *
 * Returns are kept and FLAGGED rather than dropped or netted off. A credit
 * note against an order-sourced bill is a real event the register should
 * show, but it never moved the order's own counter (lib/orderClaims.mjs only
 * acts on the original sale), so quietly subtracting it here would make the
 * list disagree with the pending quantity beside it.
 */
export const billingInvoices = (invoices, { orderNo, type } = {}) => {
  const wantNo = num(orderNo);
  const wantType = text(type);

  return (invoices || [])
    .filter(Boolean)
    .map((invoice) => {
      const mine = (invoice.items || [])
        .filter(Boolean)
        .filter((l) => num(l.orderNo) === wantNo && text(l.orderType) === wantType);
      return {
        invoiceNo: num(invoice.invoiceNo),
        date: asDate(invoice.date),
        isReturn: Boolean(invoice.return ?? invoice.isReturn),
        quantity: roundQty(mine.reduce((sum, l) => sum + Math.max(0, num(l.quantity)), 0)),
        lines: mine.map((l) => ({
          item: text(l.name),
          quantity: Math.max(0, roundQty(l.quantity)),
          orderLineId: text(l.orderLineId),
        })),
      };
    })
    .filter((row) => row.lines.length)
    .sort((a, b) => a.invoiceNo - b.invoiceNo);
};

/** "Billed by 3 invoices" / "Nothing billed yet" -- one line for a row. */
export const billingSummary = (invoices) => {
  const rows = invoices || [];
  if (!rows.length) return "Nothing billed against this order yet";
  const sales = rows.filter((r) => !r.isReturn).length;
  const returns = rows.length - sales;
  const parts = [`${sales} invoice${sales === 1 ? "" : "s"}`];
  if (returns) parts.push(`${returns} return${returns === 1 ? "" : "s"}`);
  return `Billed by ${parts.join(" and ")}`;
};

// ── CSV ───────────────────────────────────────────────────────────────────

// The escaping rules moved to lib/csv.mjs, which is where they always
// belonged -- lib/accountBooks.mjs carried a comment apologising for their
// living here. Re-exported under the same names so every existing importer
// (account books, sales reports, GST returns, the order reports below) keeps
// working against one copy rather than two that can drift.
export { csvCell, toCsv } from "./csv.mjs";

/** The column sets each report downloads as. */
export const CSV_COLUMNS = {
  register: [
    { key: "orderNo", label: "Order No" },
    { key: "date", label: "Date" },
    { key: "party", label: "Party" },
    { key: "reference", label: "Their Ref" },
    { key: "deliveryDate", label: "Delivery By" },
    { key: "status", label: "Status" },
    { key: "lineCount", label: "Lines" },
    { key: "pendingCount", label: "Pending Lines" },
    { key: "orderValue", label: "Order Value" },
    { key: "pendingValue", label: "Still To Bill" },
    { key: "oldestOverdue", label: "Days Overdue" },
  ],
  "party-pending": [
    { key: "party", label: "Party" },
    { key: "orderCount", label: "Orders" },
    { key: "lineCount", label: "Lines" },
    { key: "pendingQty", label: "Pending Qty" },
    { key: "pendingValue", label: "Pending Value" },
    { key: "overdueLines", label: "Overdue Lines" },
    { key: "oldestOverdue", label: "Days Overdue" },
  ],
  // Sigfa's own five headings, spelled exactly as its sheet prints them --
  // the full stops in "ORDER.QTY" and "DESP QTY." included, because they are
  // what the shop reads and a tidied-up version would not match the paper
  // beside the screen. CURRENT STOCK is the one addition.
  "item-pending": [
    { key: "item", label: "ITEM NAME" },
    { key: "unit", label: "UNIT" },
    { key: "orderQty", label: "ORDER.QTY" },
    { key: "despQty", label: "DESP QTY." },
    { key: "balance", label: "BALANCE" },
    // `r.known` rather than a falsy test: an item with nothing on the shelf
    // has a stock of 0, which is falsy, and would otherwise export as
    // "not in master".
    { key: "stock", label: "CURRENT STOCK", value: (r) => (r.known ? r.stock : "not in master") },
    // Kept after Sigfa's set rather than mixed into it: these are this app's
    // own columns, and a download is where a spreadsheet wants them.
    { key: "shortBy", label: "Short By" },
    { key: "orderCount", label: "Orders" },
    { key: "lineCount", label: "Lines" },
    { key: "pendingValue", label: "Pending Value" },
    { key: "overdueLines", label: "Overdue Lines" },
    { key: "oldestOverdue", label: "Days Overdue" },
  ],
  detail: [
    { key: "orderNo", label: "Order No" },
    { key: "orderDate", label: "Order Date" },
    { key: "party", label: "Party" },
    { key: "item", label: "Item" },
    { key: "hsn", label: "HSN" },
    { key: "uqc", label: "Unit" },
    { key: "ordered", label: "Ordered" },
    { key: "billed", label: "Billed" },
    { key: "cancelled", label: "Cancelled" },
    { key: "pending", label: "Pending" },
    { key: "rate", label: "Rate" },
    { key: "value", label: "Pending Value" },
    { key: "promised", label: "Promised" },
    { key: "overdueDays", label: "Days Overdue" },
  ],
  reconcile: [
    { key: "type", label: "Type" },
    { key: "orderNo", label: "Order No" },
    { key: "item", label: "Item" },
    { key: "stored", label: "Order Says Billed" },
    { key: "derived", label: "Invoices Say Billed" },
    { key: "difference", label: "Difference" },
    { key: "reason", label: "Reason" },
  ],
};

/** A download file name that says what it is and when it was taken. */
export const csvFilename = (report, type, now = Date.now()) => {
  const stamp = new Date(now).toISOString().slice(0, 10);
  const kind = isOrderType(type) ? type.toLowerCase() : "all";
  return `${kind}-order-${report}-${stamp}.csv`;
};

/**
 * Sigfa's own headings for the item-wise sheet.
 *
 * Taken from its printed output, character for character:
 *
 *     ITEM WISE SALES PENDING ORDERS
 *         (SUPER CONSOLIDATED)
 *     FOR THE PERIOD FROM  01-04-2026 TO 31-03-2027
 *     ITEM NAME        UNIT    ORDER.QTY   DESP QTY.    BALANCE
 *     TOTAL  :-
 *
 * Upper case, the full stops where Sigfa puts them, and "DESP" rather than
 * "DESPATCHED". A tidied-up version would read better and match nothing: the
 * point of copying these is that the shop compares this screen against the
 * paper beside it.
 *
 * "(SUPER CONSOLIDATED)" is Sigfa's name for a sheet that totals an item
 * across every order and party rather than listing it per order -- which is
 * exactly what this view does.
 */
export const SIGFA_ITEM_HEADERS = ["ITEM NAME", "UNIT", "ORDER.QTY", "DESP QTY.", "BALANCE"];

/** The column this app adds to Sigfa's five. */
export const STOCK_HEADER = "CURRENT STOCK";

export const CONSOLIDATION_LABEL = "(SUPER CONSOLIDATED)";

/** Sigfa writes its totals row with a colon and a dash. */
export const TOTAL_LABEL = "TOTAL  :-";

/** "ITEM WISE SALES PENDING ORDERS" / "ITEM WISE PURCHASE PENDING ORDERS". */
export const sigfaItemTitle = (type) =>
  `ITEM WISE ${type === "Purchase" ? "PURCHASE" : "SALES"} PENDING ORDERS`;

/** Sigfa dates its periods dd-mm-yyyy. */
const sigfaDate = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
};

/**
 * "FOR THE PERIOD FROM  01-04-2026 TO 31-03-2027".
 *
 * Returns "" when neither end is set, so the line is left off rather than
 * printed with blanks in it -- a sheet claiming a period it does not have is
 * worse than one that claims none.
 */
export const sigfaPeriodLine = (from, to) => {
  const start = sigfaDate(from);
  const end = sigfaDate(to);
  if (!start && !end) return "";
  if (start && end) return `FOR THE PERIOD FROM  ${start} TO ${end}`;
  return start ? `FOR THE PERIOD FROM  ${start}` : `UP TO  ${end}`;
};

/** The totals row under the item-wise sheet. */
export const sigfaItemTotals = (rows = []) => ({
  orderQty: roundQty(rows.reduce((t, r) => t + (Number(r?.orderQty) || 0), 0)),
  despQty: roundQty(rows.reduce((t, r) => t + (Number(r?.despQty) || 0), 0)),
  balance: roundQty(rows.reduce((t, r) => t + (Number(r?.balance) || 0), 0)),
  // Deliberately NOT totalled: adding a tonne of steel to four hundred
  // washers gives a number that means nothing. Sigfa leaves its stock
  // columns untotalled for the same reason.
  stock: null,
});

/** The heading a printed sheet carries. */
export const reportTitle = (report, type) => {
  const doc = type === "Purchase" ? "Purchase Order" : "Sales Order";
  switch (report) {
    case "register":
      return `${doc} Register`;
    case "party-pending":
      return `Party-wise Pending ${doc}s`;
    case "item-pending":
      return `Item-wise Pending ${doc}s`;
    case "reconcile":
      return `${doc} Reconciliation`;
    default:
      return `${doc} Report`;
  }
};

export { ORDER_TYPES, trim };
