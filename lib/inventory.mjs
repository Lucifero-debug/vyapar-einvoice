/**
 * The stock reports.
 *
 * Pure and dependency-free except for the two project modules that already own
 * figures this one needs, so `node` can run scripts/inventory.test.mjs
 * directly. Never import Mongoose in here.
 *
 *
 * SIGFA'S OWN REPORTS, AND ITS OWN COLUMN NAMES
 * ---------------------------------------------
 * The stock block of Sigfa's Reports menu reads, in its order:
 *
 *   Stock Ledger · Stock Summary · Stock Ledger Value Wise ·
 *   Stock Summary Value Wise · Quantity Value Analysis · Budget Report ·
 *   GST Wise Stock Value · GST & VAT Compare Stock · Stock Aging Analysis ·
 *   Stock Aging Analysis Slab Wise · Under-Over Stock · Only Stock Position ·
 *   Issue Slip Register · Receipt Slip Register · Stock Day Book · CheckList ·
 *   Physical Stock Comparison · Stock Ledger Parent · Stock Summary Parent ·
 *   Branch Wise Stock · Store Wise Stock
 *
 * and `Stock Short List` sits in the Misc menu beside `Cash Short List`.
 * The group/parent/company/branch/store variants are Sigfa's multi-location
 * and multi-company dimensions, which this app does not have; `group` on the
 * item master is the one of them it does.
 *
 * The column captions here are Sigfa's, read out of the binary rather than
 * invented: `Opening Quantity`, `Rcpt. Qty.`, `Issue Qty.`, `Balance Qty.`,
 * and on the day book `Vch Type`, `Voucher`, `Party Name`. The shortfall
 * column is headed `Required`, which is the word Sigfa's own stock warning
 * uses beside `Minimum Level` and `Re-Order Level`.
 *
 *
 * THE FIGURE IS THE LEDGER'S. THIS MODULE DOES NOT KEEP ITS OWN
 * ------------------------------------------------------------
 * There is exactly one stock balance in this app and it is summed from the
 * item ledger -- see lib/itemStock.mjs, which explains at length why neither
 * `Item.lastQuantity` (typed in by hand, never written by the posting path)
 * nor a row's `balanceQuantity` (a running cache a back-dated entry leaves
 * stale) can be used. Nothing below reads either one.
 *
 * What a PERIOD report needs on top of that is the split:
 *
 *     Opening Quantity  =  the master's opening  +  everything before `from`
 *     Rcpt. Qty.        =  receipts inside the window
 *     Issue Qty.        =  issues inside the window
 *     Balance Qty.      =  opening + receipts - issues
 *
 * which is the same arithmetic `accountBook()` does for a party, and the same
 * reason: an opening computed from before the window is the only way a
 * back-dated entry lands in the right place. For a window that reaches today,
 * `Balance Qty.` equals `buildStockIndex()`'s quantity for that item, and a
 * test pins that -- if the two ever disagree, this module is wrong.
 *
 *
 * WHAT CAN HONESTLY BE VALUED, AND WHAT CANNOT
 * --------------------------------------------
 * Sigfa offers seven valuation bases:
 *
 *     Weighted Rate : Fifo Basis : Lifo Basis : On Purchase Price :
 *     On Last Purc Price : On Cost Price : On MRP
 *
 * Five of them this app's data carries. `ItemLedger` has NO rate column --
 * every row is quantities and a date -- so a FIFO or LIFO *valuation*, which
 * needs the rate on each surviving layer, cannot be computed from it. Rather
 * than approximate it from the master's cost and call it FIFO, those two are
 * listed, refused, and the reason is printed. A number labelled FIFO that is
 * not FIFO is worse than a missing report: it would be carried into a balance
 * sheet.
 *
 * FIFO *aging* is a different question and IS supportable, because ageing
 * needs only quantities and dates. Receipts are consumed oldest-first by the
 * total issued, and what survives is the stock still on hand with the date it
 * came in. That is what `agingOf` does.
 *
 *
 * NOTHING HERE IS A SECOND OPINION
 * --------------------------------
 * - The closing quantity is `buildStockIndex`'s (lib/itemStock.mjs).
 * - "What counts as low" is `lowStockRows`'s (lib/dashboard.mjs) -- the
 *   dashboard's alert and the Short List are the same question, so they share
 *   one rule and all three of Sigfa's levels live in it.
 * - The weighted average purchase rate is `itemWise`'s (lib/salesReports.mjs),
 *   whose `rate` is already taxable-value over quantity across the purchase
 *   documents. Returns net off, which is right for a cost too.
 *
 * The only figures this module originates are the period split, the ageing
 * layers and the physical-count difference.
 */

import { istDayIndex, istDayNumber } from "./istDate.mjs";
import { buildStockIndex, formatQuantity, stockOf } from "./itemStock.mjs";
import { STOCK_REASONS, lowStockRows, stockSummary } from "./dashboard.mjs";
import { itemWise } from "./salesReports.mjs";
import { isStockLedgerKey, STOCK_KIND_CODES, STOCK_KINDS } from "./stockVoucher.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Quantities round to three places, not two.
 *
 * Money is paise and rounds to two (`round2` in lib/balance.mjs). A quantity
 * is kilos, metres and litres, and 0.125 kg is a real weight that two places
 * would turn into 0.13 -- which, multiplied by a rate, is a different bill.
 * lib/itemStock.mjs's `formatQuantity` prints to three for the same reason.
 */
export const round3 = (value) => Math.round((num(value) + Number.EPSILON) * 1000) / 1000;

/** Money, the same way the rest of the app rounds it. */
const round2 = (value) => Math.round((num(value) + Number.EPSILON) * 100) / 100;

/* ─────────────────────────── the reports ─────────────────────────────── */

/**
 * The item-level reports this module serves, in Sigfa's menu order.
 *
 * `key` is what the route and the page pass around; `name` is what Sigfa calls
 * it, which is what the client will look for.
 */
export const STOCK_REPORTS = [
  {
    key: "summary",
    name: "Stock Summary",
    blurb: "Opening, receipts, issues and the closing quantity, one row per item.",
    period: true,
  },
  {
    key: "value",
    name: "Stock Summary Value Wise",
    blurb: "The same sheet with a rate and a value, on whichever basis you pick.",
    period: true,
  },
  {
    key: "short",
    name: "Stock Short List",
    blurb: "What has run out, gone negative, or fallen below its minimum or re-order level.",
    // A level is compared against stock as it stands, not as it stood in June.
    period: false,
  },
  {
    key: "aging",
    name: "Stock Aging Analysis",
    blurb: "How long the stock on hand has been sitting, in day slabs.",
    period: false,
  },
  {
    key: "daybook",
    name: "Stock Day Book",
    blurb: "Every movement of every item in date order, as entered.",
    period: true,
  },
];

export const STOCK_REPORT_KEYS = STOCK_REPORTS.map((r) => r.key);

export const isStockReport = (key) => STOCK_REPORT_KEYS.includes(text(key));

export const stockReportName = (key) =>
  STOCK_REPORTS.find((r) => r.key === text(key))?.name || "";

/** Whether this report takes a date range at all. */
export const reportTakesPeriod = (key) =>
  STOCK_REPORTS.find((r) => r.key === text(key))?.period === true;

/* ──────────────────────── movements and the period ───────────────────── */

/** Every ledger row, in the order a day book reads them. */
export const inOrder = (rows = []) =>
  [...rows]
    .filter(Boolean)
    .map((row) => ({ ...row, day: istDayNumber(row?.date) }))
    .filter((row) => row.day !== null)
    .sort(
      (a, b) =>
        a.day - b.day ||
        String(a.invoiceNo ?? "").localeCompare(String(b.invoiceNo ?? ""), undefined, {
          numeric: true,
        }) ||
        String(a._id ?? "").localeCompare(String(b._id ?? ""))
    );

/** Is this row's IST calendar day inside the window? Both ends inclusive. */
export const inWindow = (day, from, to) => {
  if (day === null || day === undefined) return false;
  const start = from ? istDayNumber(from) : null;
  const end = to ? istDayNumber(to) : null;
  if (start !== null && day < start) return false;
  if (end !== null && day > end) return false;
  return true;
};

/**
 * What kind of document a stock row came off, in words.
 *
 * `typeOfVoucher` on an invoice's rows is only ever "Sale" or "Purchase" --
 * the writer does not record the return flag (lib/itemLedger.mjs) -- so a
 * sales return reads as a "Sale" row that RECEIVES stock. The direction
 * supplies what the column does not, which is sound because the direction is
 * exactly `isInwardStock({ type, isReturn })`: inward on a Sale can only be a
 * return, outward on a Purchase can only be a return.
 *
 * Stock vouchers are told apart by their key's prefix, not by
 * `typeOfVoucher`, which the writer hardcodes to "Production" for all three
 * kinds.
 */
export const voucherTypeOf = (row) => {
  const key = text(row?.invoiceNo);
  if (isStockLedgerKey(key)) {
    const code = STOCK_KIND_CODES.find((c) => key.startsWith(STOCK_KINDS[c].prefix));
    return code ? STOCK_KINDS[code].label : "Production";
  }

  const kind = text(row?.typeOfVoucher);
  const received = num(row?.receiptQuantity) > 0;
  if (kind === "Purchase") return received ? "Purchase" : "Purchase Return";
  if (kind === "Sale") return received ? "Sales Return" : "Sale";
  return kind || "Stock";
};

/**
 * One row per item: the period split, with Sigfa's four quantity columns.
 *
 * `items` are the master records (needed for the opening quantity, the unit
 * and the group); `rows` are the ledger rows for the items in question --
 * ALL of them, not just the window's, because the opening is computed from
 * what came before `from`.
 *
 * An item with no movements still appears at its opening quantity, and a
 * movement for an item no longer in the master appears counted from zero,
 * both for the same reason lib/itemStock.mjs gives: a stock sheet that
 * silently omits rows is a stock sheet nobody can reconcile.
 */
export const stockPeriod = ({ items = [], rows = [], from, to } = {}) => {
  const out = new Map();

  const blank = (name) => ({
    name,
    unit: "",
    group: "",
    hsn: "",
    id: "",
    opening: 0,
    receipts: 0,
    issues: 0,
    closing: 0,
  });

  for (const item of items.filter(Boolean)) {
    const name = text(item?.name);
    if (!name) continue;
    const entry = blank(name);
    entry.unit = text(item?.unit);
    entry.group = text(item?.group);
    entry.hsn = text(item?.hsn);
    entry.id = text(item?._id ?? item?.id);
    entry.opening = round3(item?.openingQuantity);
    out.set(name.toLowerCase(), entry);
  }

  const start = from ? istDayNumber(from) : null;

  for (const row of inOrder(rows)) {
    const name = text(row?.itemName);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!out.has(key)) out.set(key, blank(name));
    const entry = out.get(key);

    const received = round3(row?.receiptQuantity);
    const issued = round3(row?.issueQuantity);

    // Before the window: it is part of the opening, not of the movements.
    if (start !== null && row.day < start) {
      entry.opening = round3(entry.opening + received - issued);
      continue;
    }
    if (!inWindow(row.day, from, to)) continue;

    entry.receipts = round3(entry.receipts + received);
    entry.issues = round3(entry.issues + issued);
  }

  return [...out.values()]
    .map((entry) => ({
      ...entry,
      closing: round3(entry.opening + entry.receipts - entry.issues),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** The totals under a stock summary. */
export const stockPeriodTotals = (rows = []) => ({
  items: rows.length,
  opening: round3(rows.reduce((t, r) => t + num(r?.opening), 0)),
  receipts: round3(rows.reduce((t, r) => t + num(r?.receipts), 0)),
  issues: round3(rows.reduce((t, r) => t + num(r?.issues), 0)),
  closing: round3(rows.reduce((t, r) => t + num(r?.closing), 0)),
  // Not a money total unless every row carried a value.
  value: rows.some((r) => r?.value === null || r?.value === undefined)
    ? null
    : round2(rows.reduce((t, r) => t + num(r?.value), 0)),
});

/**
 * Sigfa's own option on the stock summary: `Print Only Negative Stock`.
 *
 * Kept because it is the one filter a shop actually uses on this sheet -- a
 * negative closing quantity means something was billed that was never
 * received, and on a list of four hundred items it is invisible.
 */
export const STOCK_FILTERS = ["all", "negative", "nonzero", "moved"];
export const DEFAULT_FILTER = "all";
export const isStockFilter = (filter) => STOCK_FILTERS.includes(text(filter));

export const FILTER_LABELS = {
  all: "Every item",
  negative: "Only negative stock",
  nonzero: "Only items with stock",
  moved: "Only items that moved",
};

export const applyFilter = (rows = [], filter = DEFAULT_FILTER) => {
  const which = isStockFilter(filter) ? text(filter) : DEFAULT_FILTER;
  if (which === "negative") return rows.filter((r) => num(r?.closing) < 0);
  if (which === "nonzero") return rows.filter((r) => num(r?.closing) !== 0);
  if (which === "moved") return rows.filter((r) => num(r?.receipts) !== 0 || num(r?.issues) !== 0);
  return rows;
};

/**
 * The summary's columns, in the shape lib/xlsx.mjs and lib/csv.mjs take.
 *
 * `label` is Sigfa's own caption. `type: "qty"` so a quantity is written as a
 * number with three decimals rather than as text -- a spreadsheet column of
 * strings cannot be summed, which is the first thing anyone does to a stock
 * sheet.
 */
export const STOCK_COLUMNS = [
  { key: "name", label: "Item Name", type: "text", width: 30 },
  { key: "unit", label: "Unit", type: "text", width: 8 },
  { key: "opening", label: "Opening Quantity", type: "qty", width: 14 },
  { key: "receipts", label: "Rcpt. Qty.", type: "qty", width: 12 },
  { key: "issues", label: "Issue Qty.", type: "qty", width: 12 },
  { key: "closing", label: "Balance Qty.", type: "qty", width: 13 },
];

/** Just the captions, for a table on screen. */
export const headings = (columns = []) => columns.map((c) => c?.label ?? c?.key ?? "");

/* ──────────────────────── the three stock levels ─────────────────────── */

/**
 * Sigfa's three levels, from ITMAST's MINLVL, ORDLVL and MAXLVL.
 *
 * Its online stock check prints all three beside the current stock:
 *
 *     Current Stock    :  40
 *     Re-Order Level   :  60        Required  :  20
 *     Minimum Level    :  25
 *
 * so the re-order level normally sits ABOVE the minimum: you order again
 * before you reach the floor, not after. Nothing here enforces that order --
 * `levelProblem` only refuses a maximum below a minimum, which is a typo
 * rather than a policy.
 */
export const LEVEL_FIELDS = [
  { key: "minQuantity", label: "Minimum Level", sigfa: "MINLVL" },
  { key: "reorderLevel", label: "Re-Order Level", sigfa: "ORDLVL" },
  { key: "maxLevel", label: "Maximum Level", sigfa: "MAXLVL" },
];

/** A level that was never set is null, never zero -- see models/itemModel.js. */
export const levelOf = (item, key) => {
  const raw = item?.[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? round3(n) : null;
};

export const levelsOf = (item) => ({
  minimum: levelOf(item, "minQuantity"),
  reorder: levelOf(item, "reorderLevel"),
  maximum: levelOf(item, "maxLevel"),
});

/**
 * Why these levels cannot be saved, in words. Null when they can.
 *
 * For the item master's form. A negative level is meaningless and a maximum
 * under the minimum is a swap of the two boxes.
 */
export const levelProblem = (item) => {
  const { minimum, reorder, maximum } = levelsOf(item);

  for (const { key, label } of LEVEL_FIELDS) {
    const value = levelOf(item, key);
    if (value !== null && value < 0) return `${label} cannot be negative.`;
  }

  if (maximum !== null && minimum !== null && maximum < minimum) {
    return "The maximum level is below the minimum level.";
  }
  if (maximum !== null && reorder !== null && maximum < reorder) {
    return "The maximum level is below the re-order level.";
  }

  return null;
};

/**
 * Sigfa's `Stock Short List` and `Under-Over Stock`, as one sheet.
 *
 * Both answer "which items need attention", and splitting them into two
 * screens would mean two rules for what counts. The reason column says which
 * it is, and `lowStockRows` in lib/dashboard.mjs decides -- the same function
 * the dashboard tile uses, so the tile and this report can never disagree.
 */
export const SHORT_LIST_REASONS = STOCK_REASONS;

export const shortList = ({ items = [], movements = [], stock = null, reasons = STOCK_REASONS } = {}) => {
  const index = stock || buildStockIndex({ items, movements });
  return lowStockRows({ stock: index, items, reasons });
};

export const shortListSummary = ({ items = [], movements = [], stock = null, rows = null } = {}) => {
  const index = stock || buildStockIndex({ items, movements });
  return stockSummary({ rows: rows || shortList({ items, stock: index }), stock: index, items });
};

/** `Required` is Sigfa's heading for the shortfall -- the same number. */
export const SHORT_COLUMNS = [
  { key: "name", label: "Item Name", type: "text", width: 30 },
  { key: "unit", label: "Unit", type: "text", width: 8 },
  { key: "quantity", label: "Balance Qty.", type: "qty", width: 13 },
  { key: "minimum", label: "Minimum Level", type: "qty", width: 14 },
  { key: "reorder", label: "Re-Order Level", type: "qty", width: 14 },
  { key: "maximum", label: "Maximum Level", type: "qty", width: 14 },
  { key: "shortfall", label: "Required", type: "qty", width: 12 },
  { key: "excess", label: "Excess", type: "qty", width: 12 },
  { key: "reasonLabel", label: "Reason", type: "text", width: 20 },
];

/* ────────────────────────── ageing the stock ─────────────────────────── */

/** `yyyymmdd` back to `yyyy-mm-dd`, so the day index helper can read it. */
const dayToIso = (key) => {
  const n = Number(key);
  if (!Number.isFinite(n)) return null;
  const s = String(n).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/**
 * The day slabs, which Sigfa calls `Aging Days Slabs` and takes as a typed
 * list in its printer setup.
 *
 * A REPORT INPUT, not a company setting: a slab list changes with the
 * question being asked (a month for perishables, a year for steel), and the
 * brief for this work says plainly not to add settings that alter accounting
 * behaviour. 30/60/90/180 are the boundaries a trading business uses.
 */
export const DEFAULT_AGING_SLABS = [30, 60, 90, 180];
export const MAX_AGING_SLABS = 6;

/** Why this slab list cannot be used. Null when it can. */
export const slabProblem = (slabs) => {
  if (!Array.isArray(slabs) || !slabs.length) return "Give at least one day slab.";
  if (slabs.length > MAX_AGING_SLABS) {
    return `That is ${slabs.length} slabs. Use at most ${MAX_AGING_SLABS}.`;
  }
  let previous = 0;
  for (const slab of slabs) {
    const days = Number(slab);
    if (!Number.isInteger(days) || days <= 0) return "Every slab must be a whole number of days.";
    if (days <= previous) return "The slabs must increase.";
    previous = days;
  }
  return null;
};

/** "0-30 days", "31-60 days", ..., "Above 180 days". */
export const slabLabels = (slabs = DEFAULT_AGING_SLABS) => {
  const out = [];
  let previous = 0;
  for (const slab of slabs) {
    out.push(previous === 0 ? `0-${slab} days` : `${previous + 1}-${slab} days`);
    previous = Number(slab);
  }
  out.push(`Above ${previous} days`);
  return out;
};

/** Which slab an age in days falls in -- the index into `slabLabels`. */
export const slabIndexOf = (days, slabs = DEFAULT_AGING_SLABS) => {
  const age = num(days);
  for (let i = 0; i < slabs.length; i += 1) {
    if (age <= Number(slabs[i])) return i;
  }
  return slabs.length;
};

/**
 * The receipts still on the shelf, oldest first, after the issues have eaten
 * into them.
 *
 * FIFO, which for AGEING needs nothing this app lacks: a receipt's quantity
 * and its date. The master's opening quantity is the oldest layer of all and
 * is dated `openingDate` -- the start of the books -- because stock carried
 * forward is by definition older than anything received since.
 *
 * Issues are applied in date order against whatever is open at the time. A
 * total of issues larger than the receipts leaves nothing, which is what a
 * negative stock means and is reported as an age of zero rather than as a
 * layer.
 */
export const agingLayers = ({ opening = 0, openingDate = null, rows = [] } = {}) => {
  const layers = [];
  const open = round3(opening);
  if (open > 0) layers.push({ day: istDayNumber(openingDate), quantity: open, opening: true });

  let shortfall = 0;

  for (const row of inOrder(rows)) {
    const received = round3(row?.receiptQuantity);
    const issued = round3(row?.issueQuantity);

    if (received > 0) {
      let left = received;
      // An earlier over-issue is covered by this receipt before any of it is
      // treated as stock on hand -- otherwise a shop that billed before the
      // bill arrived would show the same goods as both missing and aged.
      if (shortfall > 0) {
        const used = Math.min(shortfall, left);
        shortfall = round3(shortfall - used);
        left = round3(left - used);
      }
      if (left > 0) layers.push({ day: row.day, quantity: left, opening: false });
    }

    let toIssue = round3(issued);
    while (toIssue > 0 && layers.length) {
      const first = layers[0];
      const taken = Math.min(first.quantity, toIssue);
      first.quantity = round3(first.quantity - taken);
      toIssue = round3(toIssue - taken);
      if (first.quantity <= 0) layers.shift();
    }
    if (toIssue > 0) shortfall = round3(shortfall + toIssue);
  }

  return { layers, shortfall };
};

/**
 * One row per item: its stock on hand spread across the day slabs.
 *
 * `asOf` is the date the ageing is measured from -- today, normally. A layer
 * with no date at all (an opening quantity on a firm that has not said when
 * its books start) goes in the oldest slab, which is the truthful place for
 * stock of unknown age rather than the newest.
 */
export const agingOf = ({
  items = [],
  rows = [],
  asOf = Date.now(),
  slabs = DEFAULT_AGING_SLABS,
  openingDate = null,
} = {}) => {
  const labels = slabLabels(slabs);
  const today = istDayIndex(asOf);

  const byItem = new Map();
  for (const row of rows.filter(Boolean)) {
    const name = text(row?.itemName);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(row);
  }

  const known = new Set();
  const out = [];

  const rowFor = (name, item, ledgerRows) => {
    const { layers } = agingLayers({
      opening: item ? num(item.openingQuantity) : 0,
      openingDate,
      rows: ledgerRows,
    });

    const buckets = labels.map(() => 0);
    let oldest = null;
    let newest = null;

    for (const layer of layers) {
      const index =
        layer.day === null || today === null
          ? labels.length - 1
          : slabIndexOf(today - istDayIndex(dayToIso(layer.day)), slabs);
      buckets[index] = round3(buckets[index] + layer.quantity);
      if (layer.day !== null) {
        if (oldest === null || layer.day < oldest) oldest = layer.day;
        if (newest === null || layer.day > newest) newest = layer.day;
      }
    }

    const onHand = round3(buckets.reduce((t, b) => t + b, 0));

    return {
      name,
      unit: text(item?.unit),
      group: text(item?.group),
      id: text(item?._id ?? item?.id),
      onHand,
      buckets,
      // The age of the oldest thing still on the shelf, which is the number a
      // shop acts on. Null when nothing is on hand.
      oldestDays: oldest === null || today === null ? null : today - istDayIndex(dayToIso(oldest)),
      newestDays: newest === null || today === null ? null : today - istDayIndex(dayToIso(newest)),
    };
  };

  for (const item of items.filter(Boolean)) {
    const name = text(item?.name);
    if (!name) continue;
    known.add(name.toLowerCase());
    out.push(rowFor(name, item, byItem.get(name.toLowerCase()) || []));
  }

  // Movements for an item that has been deleted from the master still aged,
  // for the same reason the summary keeps them.
  for (const [key, ledgerRows] of byItem) {
    if (known.has(key)) continue;
    out.push(rowFor(text(ledgerRows[0]?.itemName), null, ledgerRows));
  }

  return out.sort((a, b) => (b.oldestDays ?? -1) - (a.oldestDays ?? -1) || a.name.localeCompare(b.name));
};

export const agingColumns = (slabs = DEFAULT_AGING_SLABS) => [
  { key: "name", label: "Item Name", type: "text", width: 30 },
  { key: "unit", label: "Unit", type: "text", width: 8 },
  { key: "onHand", label: "Balance Qty.", type: "qty", width: 13 },
  ...slabLabels(slabs).map((label, i) => ({
    key: `slab${i}`,
    label,
    type: "qty",
    width: 14,
    // The buckets are an array on the row, so the column reads it by index
    // rather than needing the row flattened into slab0..slabN -- which would
    // have to be kept in step with the slab list in two places.
    value: (row) => row?.buckets?.[i],
  })),
  { key: "oldestDays", label: "Oldest (days)", type: "int", width: 13 },
];

export const agingTotals = (rows = [], slabs = DEFAULT_AGING_SLABS) => ({
  items: rows.length,
  onHand: round3(rows.reduce((t, r) => t + num(r?.onHand), 0)),
  buckets: slabLabels(slabs).map((_, i) =>
    round3(rows.reduce((t, r) => t + num(r?.buckets?.[i]), 0))
  ),
});

/* ───────────────────────────── valuation ─────────────────────────────── */

/**
 * Sigfa's seven bases, five of them supportable here.
 *
 * `name` is Sigfa's own wording, from the option row its value-wise reports
 * print: "Weighted Rate : Fifo Basis : Lifo Basis : On Purchase Price :
 * On Last Purc Price : On Cost Price : On MRP."
 */
export const VALUATION_BASES = [
  {
    key: "weighted",
    name: "Weighted Rate",
    source: "The average rate actually paid across every purchase bill, returns netted off.",
    supported: true,
  },
  {
    key: "lastPurchase",
    name: "On Last Purc Price",
    source: "The rate on the most recent purchase bill for the item.",
    supported: true,
  },
  {
    key: "purchase",
    name: "On Purchase Price",
    source: "`purchasePrice` on the item master.",
    supported: true,
  },
  {
    key: "cost",
    name: "On Cost Price",
    source: "`cost` on the item master -- the figure the balance sheet already uses.",
    supported: true,
  },
  {
    key: "mrp",
    name: "On MRP",
    source: "`mrp` on the item master.",
    supported: true,
  },
  {
    key: "fifo",
    name: "Fifo Basis",
    source: "",
    supported: false,
    why:
      "The stock ledger records quantities and dates, not a rate per movement, so there is no rate to attach to the surviving layers. Ageing is still done on a FIFO basis, which needs only the dates.",
  },
  {
    key: "lifo",
    name: "Lifo Basis",
    source: "",
    supported: false,
    why:
      "The same reason as FIFO: the stock ledger carries no rate per movement.",
  },
];

export const DEFAULT_BASIS = "cost";

export const basisOf = (key) => VALUATION_BASES.find((b) => b.key === text(key)) || null;

export const SUPPORTED_BASES = VALUATION_BASES.filter((b) => b.supported).map((b) => b.key);

/** Why this basis cannot be used. Null when it can. */
export const basisProblem = (key) => {
  const basis = basisOf(key);
  if (!basis) return `"${text(key)}" is not a valuation basis.`;
  if (!basis.supported) return `${basis.name} cannot be computed here. ${basis.why}`;
  return null;
};

/**
 * The weighted average rate per item, deferred to `itemWise`.
 *
 * Its `rate` is the period's taxable value over its quantity across the
 * purchase documents -- the weighted average by construction, and already
 * tested. Computing it again here would be a second opinion about what the
 * firm paid.
 *
 * `upto` bounds it, so a valuation as at 30 June is not made with rates from
 * September.
 */
export const weightedRates = ({ invoices = [], upto = null } = {}) => {
  const rows = itemWise({ invoices, side: "Purchase", to: upto || undefined });
  const out = new Map();
  for (const row of rows) {
    const name = text(row?.item);
    if (!name) continue;
    // Null rather than zero when a period's returns cancel the purchases out:
    // "we have no rate for this" is not "this cost nothing".
    out.set(name.toLowerCase(), row.rate === null ? null : round2(row.rate));
  }
  return out;
};

/**
 * The rate on the most recent purchase line for each item.
 *
 * The LINE's `cost`, which is the rate as billed, not `total / quantity`
 * (which would carry the line's discount and tax) and not the master's
 * `purchasePrice` (which is what the firm expects to pay). Returns are
 * skipped: a returned bill's rate is not the last rate paid.
 */
export const lastPurchaseRates = ({ invoices = [], upto = null } = {}) => {
  const end = upto ? istDayNumber(upto) : null;
  const best = new Map();

  for (const invoice of invoices.filter(Boolean)) {
    if (text(invoice?.type) !== "Purchase") continue;
    if (invoice?.return === true) continue;
    const day = istDayNumber(invoice?.date);
    if (day === null) continue;
    if (end !== null && day > end) continue;

    for (const line of invoice?.items || []) {
      const name = text(line?.name);
      if (!name) continue;
      const rate = Number(line?.cost);
      if (!Number.isFinite(rate) || rate <= 0) continue;

      const key = name.toLowerCase();
      const previous = best.get(key);
      const no = num(invoice?.invoiceNo);
      // Same day, later bill wins -- the bill number is the only tie-break
      // the data has, and it is the order the bills were entered in.
      if (!previous || day > previous.day || (day === previous.day && no >= previous.no)) {
        best.set(key, { day, no, rate: round2(rate) });
      }
    }
  }

  return new Map([...best].map(([key, v]) => [key, v.rate]));
};

/**
 * The rate for one item on one basis, or null.
 *
 * Null, never zero, when the basis has nothing to offer: an item with no
 * purchase history has no weighted rate, and valuing it at zero would quietly
 * write its stock off the sheet.
 *
 * `salePrice` is deliberately not a basis. Sigfa does not offer it either,
 * and valuing stock at what it sells for books the profit before the sale.
 */
export const rateFor = ({ basis = DEFAULT_BASIS, item = null, weighted = null, last = null } = {}) => {
  const key = text(item?.name).toLowerCase();
  const pick = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? round2(n) : null;
  };

  switch (text(basis)) {
    case "weighted":
      return weighted?.has?.(key) ? pick(weighted.get(key)) : null;
    case "lastPurchase":
      return last?.has?.(key) ? pick(last.get(key)) : null;
    case "purchase":
      return pick(item?.purchasePrice);
    case "cost":
      return pick(item?.cost);
    case "mrp":
      return pick(item?.mrp);
    default:
      return null;
  }
};

/**
 * The value-wise sheet: the summary rows with a rate and a value.
 *
 * A row whose rate is unknown carries `value: null` and is COUNTED as
 * unvalued rather than as zero, and the totals go null the moment one row
 * does -- a stock value that silently excluded a third of the shelf is the
 * figure that ends up in a balance sheet.
 */
export const valueRows = ({ rows = [], items = [], basis = DEFAULT_BASIS, weighted = null, last = null } = {}) => {
  const master = new Map();
  for (const item of items.filter(Boolean)) {
    const name = text(item?.name);
    if (name) master.set(name.toLowerCase(), item);
  }

  return rows.map((row) => {
    const item = master.get(text(row?.name).toLowerCase()) || { name: row?.name };
    const rate = rateFor({ basis, item, weighted, last });
    return {
      ...row,
      rate,
      value: rate === null ? null : round2(num(row?.closing) * rate),
    };
  });
};

export const valueColumns = () => [
  ...STOCK_COLUMNS,
  { key: "rate", label: "Rate", type: "money", width: 12 },
  { key: "value", label: "Value", type: "money", width: 15 },
];

/**
 * What the sheet could and could not value, said plainly under it.
 *
 * Sigfa prints a total and leaves you to notice. This names the count,
 * because the difference between "stock is worth 4.2 lakh" and "the stock we
 * have a rate for is worth 4.2 lakh" is the whole point.
 */
export const valueCoverage = (rows = []) => {
  const held = rows.filter((r) => num(r?.closing) !== 0);
  const unvalued = held.filter((r) => r?.rate === null || r?.rate === undefined);
  return {
    items: held.length,
    valued: held.length - unvalued.length,
    unvalued: unvalued.length,
    names: unvalued.slice(0, 5).map((r) => text(r?.name)),
    total: unvalued.length
      ? null
      : round2(held.reduce((t, r) => t + num(r?.value), 0)),
    // The figure for the rows that DO have a rate, always available, and
    // never presented as the stock value when something is missing.
    valuedTotal: round2(
      held.filter((r) => r?.rate !== null && r?.rate !== undefined).reduce((t, r) => t + num(r?.value), 0)
    ),
  };
};

/* ─────────────────────────── the day book ────────────────────────────── */

/**
 * Sigfa's `Stock Day Book`: every movement, every item, in date order.
 *
 * Its own SQL names these columns -- `Vch Type`, `Voucher`, `Party Name`,
 * `Rcpt Qty`, `Issue Qty` -- so those are the headings here.
 *
 * No running balance. A day book spanning every item cannot carry one
 * meaningfully, and the per-item running figure is what the Stock Ledger is
 * for (`/item-ledger`).
 */
export const dayBook = ({ rows = [], from, to, item = "" } = {}) => {
  const wanted = text(item).toLowerCase();

  return inOrder(rows)
    .filter((row) => inWindow(row.day, from, to))
    .filter((row) => (wanted ? text(row?.itemName).toLowerCase() === wanted : true))
    .map((row) => ({
      _id: row?._id ?? null,
      day: row.day,
      date: row?.date ?? null,
      voucherType: voucherTypeOf(row),
      voucher: text(row?.invoiceNo),
      party: text(row?.partyName),
      item: text(row?.itemName),
      received: round3(row?.receiptQuantity),
      issued: round3(row?.issueQuantity),
    }));
};

export const dayBookTotals = (rows = []) => ({
  movements: rows.length,
  items: new Set(rows.map((r) => text(r?.item).toLowerCase()).filter(Boolean)).size,
  received: round3(rows.reduce((t, r) => t + num(r?.received), 0)),
  issued: round3(rows.reduce((t, r) => t + num(r?.issued), 0)),
});

export const DAY_BOOK_COLUMNS = [
  { key: "date", label: "Date", type: "date", width: 12 },
  { key: "voucherType", label: "Vch Type", type: "text", width: 16 },
  { key: "voucher", label: "Voucher", type: "text", width: 12 },
  { key: "party", label: "Party Name", type: "text", width: 26 },
  { key: "item", label: "Item Name", type: "text", width: 30 },
  { key: "received", label: "Rcpt Qty", type: "qty", width: 12 },
  { key: "issued", label: "Issue Qty", type: "qty", width: 12 },
];

/* ───────────────────── physical stock comparison ─────────────────────── */

/**
 * Sigfa's `Physical Stock Comparison`, from its PHYSTOCK table -- which holds
 * the item, `AsOnBal` (the book figure when the count was taken) and `Qty`
 * (what was counted).
 *
 * Here the book figure is recomputed rather than stored, so a count typed in
 * last week is compared against what the books say NOW -- which is the
 * question being asked, and which a stored snapshot would answer with
 * last week's number.
 *
 * `counted` is `{ name, quantity }` rows. An item counted but not in the
 * master is still compared, because finding goods nobody has a master for is
 * exactly what a physical count is for.
 */
export const compareCount = ({ items = [], movements = [], stock = null, counted = [] } = {}) => {
  const index = stock || buildStockIndex({ items, movements });
  const master = new Map();
  for (const item of items.filter(Boolean)) {
    const name = text(item?.name);
    if (name) master.set(name.toLowerCase(), item);
  }

  const rows = [];
  for (const row of counted.filter(Boolean)) {
    const name = text(row?.name);
    if (!name) continue;
    const entry = stockOf(index, name);
    const book = round3(entry?.quantity);
    const physical = round3(row?.quantity);
    const item = master.get(name.toLowerCase());
    rows.push({
      name,
      unit: text(entry?.unit) || text(item?.unit),
      book,
      counted: physical,
      // Counted minus book: positive means more on the shelf than the books
      // say, which is a receipt nobody entered.
      difference: round3(physical - book),
      inMaster: Boolean(item),
    });
  }

  return rows.sort(
    (a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.name.localeCompare(b.name)
  );
};

export const countTotals = (rows = []) => ({
  items: rows.length,
  agree: rows.filter((r) => num(r?.difference) === 0).length,
  short: rows.filter((r) => num(r?.difference) < 0).length,
  excess: rows.filter((r) => num(r?.difference) > 0).length,
  book: round3(rows.reduce((t, r) => t + num(r?.book), 0)),
  counted: round3(rows.reduce((t, r) => t + num(r?.counted), 0)),
});

export const PHYSICAL_COLUMNS = [
  { key: "name", label: "Item Name", type: "text", width: 30 },
  { key: "unit", label: "Unit", type: "text", width: 8 },
  { key: "book", label: "Balance Qty.", type: "qty", width: 13 },
  { key: "counted", label: "Physical Stock", type: "qty", width: 14 },
  { key: "difference", label: "Difference", type: "qty", width: 12 },
];

/* ───────────────────────── printing and export ───────────────────────── */

/** A quantity for a sheet: three places, no unit, blank for nothing. */
export const sheetQuantity = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return String(parseFloat(n.toFixed(3)));
};

/** A quantity on screen, with its unit -- lib/itemStock.mjs's formatter. */
export const showQuantity = (value, unit = "") => formatQuantity(value, unit);

/**
 * The meta block at the head of a printed sheet or an export.
 *
 * The same shape `reportCsv` and `buildWorkbook` take (lib/csv.mjs,
 * lib/xlsx.mjs): rows with no value are dropped by those, so a basis line on
 * a sheet that has no basis simply does not print.
 */
export const stockMeta = ({ report, from, to, basis, filter, slabs, asOf } = {}) => [
  { label: "Report", value: stockReportName(report) },
  { label: "Period", value: reportTakesPeriod(report) && from && to ? `${from} to ${to}` : "" },
  { label: "As on", value: !reportTakesPeriod(report) && asOf ? asOf : "" },
  { label: "Valuation", value: text(report) === "value" ? basisOf(basis)?.name || "" : "" },
  {
    label: "Showing",
    value: text(filter) && text(filter) !== DEFAULT_FILTER ? FILTER_LABELS[text(filter)] || "" : "",
  },
  {
    label: "Day slabs",
    value: text(report) === "aging" && Array.isArray(slabs) ? slabs.join(", ") : "",
  },
];

/**
 * The export sheets for one stock report.
 *
 * One sheet, not several: each of these reports is a single table, and a
 * workbook with an empty second tab is worse than one without it. The shape
 * is lib/xlsx.mjs's (`{ name, title, meta, columns, rows, totals,
 * totalsLabel }`), and the same array drives the CSV, so the two cannot
 * disagree about what a column is called.
 */
export const stockSheets = ({
  report,
  rows = [],
  totals = null,
  from,
  to,
  basis,
  filter,
  slabs = DEFAULT_AGING_SLABS,
  asOf,
  company = null,
} = {}) => {
  const which = text(report);
  const meta = [
    ...(company?.name ? [{ label: "", value: text(company.name) }] : []),
    ...stockMeta({ report: which, from, to, basis, filter, slabs, asOf }),
  ];

  const columns =
    which === "value"
      ? valueColumns()
      : which === "short"
      ? SHORT_COLUMNS
      : which === "aging"
      ? agingColumns(slabs)
      : which === "daybook"
      ? DAY_BOOK_COLUMNS
      : STOCK_COLUMNS;

  return [
    {
      name: stockReportName(which) || "Stock",
      title: stockReportName(which),
      meta,
      columns,
      rows,
      totals,
      totalsLabel: "Total",
    },
  ];
};

/**
 * The totals row for a sheet, keyed to match its columns.
 *
 * Only the keys a total is meaningful for: a "Reason" column under the word
 * Total would read as a reason, and the xlsx writer prints nothing for a key
 * the totals object does not carry.
 */
export const sheetTotals = ({ report, rows = [], slabs = DEFAULT_AGING_SLABS } = {}) => {
  const which = text(report);

  if (which === "daybook") {
    const t = dayBookTotals(rows);
    return { received: t.received, issued: t.issued };
  }
  if (which === "aging") {
    const t = agingTotals(rows, slabs);
    const out = { onHand: t.onHand };
    t.buckets.forEach((value, i) => {
      out[`slab${i}`] = value;
    });
    return out;
  }
  if (which === "short") {
    // No total: a sum of minimum levels is not a number anybody wants, and a
    // sum of the Required column across different items is not an order.
    return null;
  }

  const t = stockPeriodTotals(rows);
  const out = {
    opening: t.opening,
    receipts: t.receipts,
    issues: t.issues,
    closing: t.closing,
  };
  // Only when every row carried one -- see stockPeriodTotals.
  if (which === "value" && t.value !== null) out.value = t.value;
  return out;
};
